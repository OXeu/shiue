import { post } from './form-request.js';

const review = document.querySelector('[data-comment-review]');
if (review) {
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const status = review.querySelector('[role="status"]');
  const button = review.querySelector('[data-approve-comment]');
  const content = review.querySelector('[data-review-content]');
  let busy = false;
  let notificationToken;
  const preview = async () => {
    if (!token) { status.textContent = '请使用审核邮件中的完整链接打开此页。'; return; }
    try {
      const result = await post(review.dataset.endpoint, { type: 'comment', action: 'preview', token });
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
      article.setAttribute('aria-label', `${result.title}（在新窗口打开）`);
      if (result.comment.parentId) {
        url.hash = `comment-${result.comment.parentId}`;
        review.querySelector('[data-review-parent-link]').href = url.href;
        review.querySelector('[data-review-parent]').hidden = false;
      }
      content.hidden = false;
      status.textContent = '';
    } catch (error) { status.textContent = `${error.name === 'AbortError' ? '读取超时。' : error.message} 请重新打开邮件中的链接重试。`; }
  };
  button.addEventListener('click', async () => {
    if (busy || !token) return;
    busy = true;
    review.setAttribute('aria-busy', 'true');
    button.disabled = true;
    status.textContent = notificationToken ? '正在重试发送通知…' : '正在提交发布任务…';
    try {
      const result = await post(review.dataset.endpoint, { type: 'comment', action: notificationToken ? 'notify' : 'approve', token, ...(notificationToken ? { notificationToken } : {}) });
      status.textContent = result.message;
      notificationToken = result.notificationToken;
      button.hidden = !notificationToken;
      if (notificationToken) button.textContent = '重试发送通知';
      else token = null;
      const link = review.querySelector('[data-workflow-link]');
      const url = new URL(result.actionsURL);
      if (url.origin === 'https://github.com') { link.href = url.href; link.hidden = false; }
    } catch (error) { status.textContent = error.name === 'AbortError' ? (notificationToken ? '通知请求超时，请重试；不会重新发布留言。' : '请求超时，请重试；重复审批不会重复添加评论。') : error.message; }
    finally { busy = false; button.disabled = false; review.removeAttribute('aria-busy'); }
  });
  preview();
}
