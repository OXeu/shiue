import { solveProof } from './comments-pow.js';

async function post(endpoint, body, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '服务暂时不可用，请稍后重试。');
    return result;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
for (const form of document.querySelectorAll('[data-comment-form]')) {
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
    const values = { path: form.dataset.path, name: data.get('name'), message: data.get('message'), website: data.get('website'), consent: data.get('consent') === 'on' };
    const fingerprint = JSON.stringify(values);
    busy = true;
    controller = new AbortController();
    fields.disabled = true;
    cancel.hidden = false;
    status.textContent = '正在获取浏览器验证任务…';
    let sending = false;
    try {
      if (!window.Worker || !crypto?.subtle || !crypto.randomUUID) throw new Error('此浏览器不支持安全验证，请使用较新的浏览器。内容已保留。');
      // 重试沿用编号和时间以便邮件去重，但每次获取新的短期验证任务。
      if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const input = { ...values, id: pending.id, createdAt: pending.createdAt };
      const task = await post(form.dataset.challengeEndpoint, input, controller.signal);
      status.textContent = '正在进行浏览器验证，通常需要几秒…';
      const proof = await solveProof(form.dataset.powWorker, task, {
        signal: controller.signal,
        onProgress: seconds => { status.textContent = `正在进行浏览器验证 · 已用 ${seconds} 秒，可随时取消`; },
      });
      // Once sending begins, cancellation cannot guarantee an email was not sent.
      cancel.hidden = true;
      sending = true;
      status.textContent = '验证完成，正在送交审核…';
      const result = await post(form.dataset.endpoint, { ...input, proof }, controller.signal);
      status.textContent = result.message || '评论已送交审核，通过后会显示在这里。';
      form.reset();
      pending = null;
    } catch (error) {
      status.textContent = controller.signal.aborted ? (sending ? '发送结果尚未确认，内容已保留；重试会使用相同评论编号。' : '已取消验证，内容已保留。') : error.name === 'AbortError' ? '请求超时，内容已保留，请重试。' : error.message;
    } finally {
      const focusSubmit = document.activeElement === cancel;
      busy = false; fields.disabled = false; cancel.hidden = true;
      if (focusSubmit) form.querySelector('[type="submit"]').focus();
    }
  });
}
const review = document.querySelector('[data-comment-review]');
if (review) {
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const status = review.querySelector('[role="status"]');
  const button = review.querySelector('[data-approve-comment]');
  const content = review.querySelector('[data-review-content]');
  let busy = false;
  const preview = async () => {
    if (!token) { status.textContent = '请使用审核邮件中的完整链接打开此页。'; return; }
    try {
      const result = await post(review.dataset.endpoint, { action: 'preview', token });
      review.querySelector('[data-review-name]').textContent = result.comment.name;
      review.querySelector('[data-review-message]').textContent = result.comment.message;
      const time = review.querySelector('[data-review-time]');
      time.dateTime = result.comment.createdAt;
      time.textContent = new Date(result.comment.createdAt).toLocaleString('zh-CN');
      const article = review.querySelector('[data-review-article]');
      const url = new URL(result.url);
      if (url.origin !== location.origin || url.protocol !== location.protocol) throw new Error('文章链接不属于本站。');
      article.href = url.href;
      article.textContent = result.title;
      content.hidden = false;
      status.textContent = '';
    } catch (error) { status.textContent = `${error.name === 'AbortError' ? '读取超时。' : error.message} 请重新打开邮件中的链接重试。`; }
  };
  button.addEventListener('click', async () => {
    if (busy || !token) return;
    busy = true;
    button.disabled = true;
    status.textContent = '正在提交发布任务…';
    try {
      const result = await post(review.dataset.endpoint, { action: 'approve', token });
      status.textContent = result.message;
      button.hidden = true;
      token = null;
      const link = review.querySelector('[data-workflow-link]');
      const url = new URL(result.actionsURL);
      if (url.origin === 'https://github.com') { link.href = url.href; link.hidden = false; }
    } catch (error) { status.textContent = error.name === 'AbortError' ? '请求超时，请重试；重复审批不会重复添加评论。' : error.message; }
    finally { busy = false; button.disabled = false; }
  });
  preview();
}
