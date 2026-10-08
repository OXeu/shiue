import './images.js';
import './site.js';
import './article.js';
import { setupCommentTimes } from './comment-time.js';
import { deferFeature } from './lazy-feature.js';

setupCommentTimes();
const comments = document.querySelector('[data-comments]');
deferFeature('comments', '[data-new-comment], [data-reply-id]', {
  prepare: button => { button.hidden = false; },
  onError: () => {
    comments.querySelector('[data-comment-load-status]').textContent = '留言编辑器加载失败，请再次点击重试。';
  },
});
deferFeature('image-preview', '[data-zoomable]', {
  keyboard: true,
  prepare: img => {
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `放大图片：${img.alt || '文章配图'}`);
  },
  onError: img => {
    img.title = '图片预览加载失败，请再次点击重试。';
    img.setAttribute('aria-label', img.title);
  },
});
