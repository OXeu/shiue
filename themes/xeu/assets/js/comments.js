import { solveTurnstile } from './turnstile.js';
import { post } from './form-request.js';
import { setupCommentEditor } from './comment-editor.js';
for (const form of document.querySelectorAll('[data-comment-form]')) {
  form.closest('[data-comments]').querySelector('[data-comment-load-status]').textContent = '';
  const fields = form.querySelector('fieldset');
  const status = form.querySelector('[role="status"]');
  const cancel = form.querySelector('[data-cancel-verification]');
  const editor = setupCommentEditor(form);
  let busy = false;
  let controller;
  cancel.addEventListener('click', () => controller?.abort());
  window.addEventListener('pagehide', () => controller?.abort());
  fields.disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const data = new FormData(form);
    const values = { path: form.dataset.path, name: data.get('name'), message: data.get('message'), website: data.get('website'), consent: data.get('consent') === 'on' };
    if (data.get('parentId')) values.parentId = data.get('parentId');
    if (data.get('email')?.trim()) values.email = data.get('email').trim();
    const fingerprint = JSON.stringify(values);
    busy = true;
    form.setAttribute('aria-busy', 'true');
    editor.saveDraft();
    controller = new AbortController();
    fields.disabled = true;
    editor.setBusy(true);
    cancel.hidden = false;
    editor.showState('verifying', '正在准备验证，请稍候…');
    let sending = false;
    try {
      if (!globalThis.crypto?.randomUUID) throw new Error('此浏览器不支持安全验证，请使用较新的浏览器。内容已保留。');
      // 重试沿用编号和时间以便邮件去重，但每次获取新的短期验证任务。
      if (!editor.pending || editor.pending.fingerprint !== fingerprint) editor.pending = { fingerprint, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const input = { ...values, id: editor.pending.id, createdAt: editor.pending.createdAt, type: 'comment' };
      const task = await post(form.dataset.endpoint, { ...input, action: 'challenge' }, controller.signal);
      if (task.submission) {
        input.id = task.submission.id;
        input.createdAt = task.submission.createdAt;
        editor.pending = { fingerprint, id: input.id, createdAt: input.createdAt };
      }
      status.textContent = '验证完成后会自动提交，请稍候。';
      const turnstileToken = await solveTurnstile(form.querySelector('[data-turnstile]'), task, { signal: controller.signal });
      // Once sending begins, cancellation cannot guarantee an email was not sent.
      cancel.hidden = true;
      sending = true;
      editor.showState('sending', '验证已完成，正在提交你的留言…');
      const result = await post(form.dataset.endpoint, { ...input, action: 'submit', turnstileToken }, controller.signal);
      editor.clearDraft();
      editor.showState('success', result.message || '评论已送交审核，通过后会显示在这里。');
    } catch (error) {
      editor.showState('editing', controller.signal.aborted ? (sending ? '发送结果尚未确认，内容已保留；重试会使用相同评论编号。' : '已取消验证，内容已保留。') : error.name === 'AbortError' ? '请求超时，内容已保留，请重试。' : error.message);
    } finally {
      const focusSubmit = document.activeElement === cancel;
      busy = false; fields.disabled = false; cancel.hidden = true;
      form.removeAttribute('aria-busy');
      editor.setBusy(false);
      if (focusSubmit) form.querySelector('[type="submit"]').focus();
    }
  });
}
