import { decode } from 'blurhash';

const initialized = new WeakSet();
function initialize(frame) {
  if (initialized.has(frame)) return;
  initialized.add(frame);
  const img = frame.querySelector('img');
  if (!img) return;
  const complete = () => {
    if (img.naturalWidth) frame.classList.add('image-loaded');
    else {
      frame.classList.add('image-failed');
      // 有占位时保留版面，正文仍可点击加载原图。
      if (!frame.classList.contains('has-placeholder') && frame.classList.contains('card-cover')) frame.hidden = true;
    }
  };
  if (frame.dataset.blurhash && !(img.complete && img.naturalWidth)) {
    try {
      const width = 32;
      const height = Math.max(1, Math.min(64, Math.round(width / (Number(frame.dataset.ratio) || 1.6))));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.className = 'image-placeholder';
      canvas.setAttribute('aria-hidden', 'true');
      const context = canvas.getContext('2d');
      if (context) {
        context.putImageData(new ImageData(decode(frame.dataset.blurhash, width, height), width, height), 0, 0);
        frame.prepend(canvas);
        frame.classList.add('has-placeholder');
      }
    } catch { /* 错误的占位元数据不影响图片加载。 */ }
  }
  img.addEventListener('load', complete, { once: true });
  img.addEventListener('error', complete, { once: true });
  if (img.complete) complete();
}
function scan(root) {
  if (!(root instanceof Element || root instanceof Document)) return;
  if (root.matches?.('[data-progressive-image]')) initialize(root);
  root.querySelectorAll('[data-progressive-image]').forEach(initialize);
}
scan(document);
new MutationObserver(entries => {
  for (const entry of entries) entry.addedNodes.forEach(scan);
}).observe(document.body, { childList: true, subtree: true });
