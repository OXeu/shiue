import { solveProof } from './comments-pow.js';
import { post } from './form-request.js';

for (const form of document.querySelectorAll('[data-friend-form]')) {
  const fields = form.querySelector('fieldset');
  const status = form.querySelector('[role="status"]');
  const cancel = form.querySelector('[data-cancel-proof]');
  let pending;
  let busy = false;
  let controller;
  cancel.addEventListener('click', () => controller?.abort());
  window.addEventListener('pagehide', () => controller?.abort());
  fields.disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const data = new FormData(form);
    const values = Object.fromEntries(['title', 'website', 'description', 'icon', 'contact'].map(key => [key, data.get(key)]));
    values.consent = data.get('consent') === 'on';
    const fingerprint = JSON.stringify(values);
    busy = true;
    controller = new AbortController();
    fields.disabled = true;
    cancel.hidden = false;
    status.textContent = '正在获取浏览器验证任务…';
    let sending = false;
    try {
      if (!window.Worker || !globalThis.crypto?.subtle || !crypto.randomUUID) throw new Error('此浏览器不支持安全验证，请使用较新的浏览器。内容已保留。');
      if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const input = { ...values, id: pending.id, createdAt: pending.createdAt, type: 'friend' };
      const task = await post(form.dataset.endpoint, { ...input, action: 'challenge' }, controller.signal);
      status.textContent = '正在进行浏览器验证，通常需要几秒…';
      const proof = await solveProof(form.dataset.powWorker, task, {
        signal: controller.signal,
        onProgress: seconds => { status.textContent = `正在进行浏览器验证 · 已用 ${seconds} 秒，可随时取消`; },
      });
      cancel.hidden = true;
      sending = true;
      status.textContent = '验证完成，正在送交审核…';
      const result = await post(form.dataset.endpoint, { ...input, action: 'submit', proof }, controller.signal);
      status.textContent = result.message;
      form.reset();
      pending = null;
    } catch (error) {
      status.textContent = controller.signal.aborted ? (sending ? '发送结果尚未确认，内容已保留；重试会使用相同申请编号。' : '已取消验证，内容已保留。') : error.name === 'AbortError' ? '请求超时，内容已保留，请重试。' : error.message;
    } finally {
      const focusSubmit = document.activeElement === cancel;
      busy = false; fields.disabled = false; cancel.hidden = true;
      if (focusSubmit) form.querySelector('[type="submit"]').focus();
    }
  });
}

const review = document.querySelector('[data-friend-review]');
if (review) {
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const status = review.querySelector('[role="status"]');
  const button = review.querySelector('[data-approve-friend]');
  let busy = false;
  let ready = false;
  const preview = async () => {
    if (!token) { status.textContent = '请使用审核邮件中的完整链接打开此页。'; return; }
    try {
      const { friend } = await post(review.dataset.endpoint, { type: 'friend', action: 'preview', token });
      for (const key of ['title', 'description']) review.querySelector(`[data-review-${key}]`).textContent = friend[key];
      for (const key of ['website', 'icon']) {
        const link = review.querySelector(`[data-review-${key}]`);
        if (!friend[key]) { link.textContent = '自动获取站点图标'; continue; }
        const url = new URL(friend[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('申请中的网址无效。');
        link.href = url.href;
        link.textContent = url.href;
      }
      const time = review.querySelector('[data-review-time]');
      time.dateTime = friend.createdAt;
      time.textContent = new Date(friend.createdAt).toLocaleString('zh-CN');
      review.querySelector('[data-review-content]').hidden = false;
      ready = true;
      status.textContent = '';
    } catch (error) { status.textContent = `${error.name === 'AbortError' ? '读取超时。' : error.message} 请重新打开邮件中的链接重试。`; }
  };
  button.addEventListener('click', async () => {
    if (busy || !token || !ready) return;
    busy = true;
    button.disabled = true;
    status.textContent = '正在提交发布任务…';
    try {
      const result = await post(review.dataset.endpoint, { type: 'friend', action: 'approve', token });
      status.textContent = result.message;
      button.hidden = true;
      token = null;
      const link = review.querySelector('[data-workflow-link]');
      const url = new URL(result.actionsURL);
      if (url.origin === 'https://github.com') { link.href = url.href; link.hidden = false; }
    } catch (error) { status.textContent = error.name === 'AbortError' ? '请求超时，请重试；重复审批不会重复添加友链。' : error.message; }
    finally { busy = false; button.disabled = false; }
  });
  preview();
}
