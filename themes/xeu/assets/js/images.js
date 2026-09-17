import { decode } from 'blurhash';

const initialized = new WeakSet();
const queue = new Set();
const decoded = new Map();
let workFrame = 0;

function preparePlaceholder(frame) {
  const img = frame.querySelector('img');
  if (!frame.isConnected || !img || !frame.dataset.blurhash || (img.complete && img.naturalWidth)) return;
  try {
    const width = 32;
    const height = Math.max(1, Math.min(64, Math.round(width / (Number(frame.dataset.ratio) || 1.6))));
    const key = `${frame.dataset.blurhash}:${height}`;
    let pixels = decoded.get(key);
    if (!pixels) {
      pixels = new ImageData(decode(frame.dataset.blurhash, width, height), width, height);
      if (decoded.size >= 32) decoded.delete(decoded.keys().next().value);
      decoded.set(key, pixels);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.className = 'image-placeholder';
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (context) {
      context.putImageData(pixels, 0, 0);
      frame.prepend(canvas);
      frame.classList.add('has-placeholder');
      frame.hidden = false;
    }
  } catch { /* 错误的占位元数据不影响图片加载。 */ }
}

function drain() {
  workFrame = 0;
  const start = performance.now();
  let count = 0;
  for (const frame of queue) {
    queue.delete(frame);
    preparePlaceholder(frame);
    if (++count >= 2 || performance.now() - start >= 4) break;
  }
  if (queue.size) workFrame = requestAnimationFrame(drain);
}
function enqueue(frame) {
  queue.add(frame);
  if (!workFrame) workFrame = requestAnimationFrame(drain);
}
const nearby = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    nearby.unobserve(entry.target);
    enqueue(entry.target);
  }
}, { rootMargin: '256px' }) : null;

function initialize(frame) {
  if (initialized.has(frame)) return;
  initialized.add(frame);
  const img = frame.querySelector('img');
  if (!img) return;
  const complete = async () => {
    if (img.naturalWidth) {
      await img.decode().catch(() => {});
      frame.classList.add('image-loaded');
      frame.classList.remove('image-failed');
      queue.delete(frame);
      nearby?.unobserve(frame);
      const removePlaceholder = () => {
        frame.querySelector('canvas')?.remove();
        img.removeEventListener('transitionend', onFadeEnd);
        clearTimeout(fallback);
      };
      const onFadeEnd = event => {
        if (event.target === img && event.propertyName === 'opacity') removePlaceholder();
      };
      img.addEventListener('transitionend', onFadeEnd);
      // 减少动态效果时没有 transitionend，仍需释放占位画布。
      const fallback = setTimeout(removePlaceholder, 400);
    }
    else {
      frame.classList.add('image-failed');
      // 有占位时保留版面，正文仍可点击加载原图。
      if (!frame.dataset.blurhash && frame.classList.contains('card-cover')) frame.hidden = true;
    }
  };
  if (nearby) nearby.observe(frame);
  else enqueue(frame);
  img.addEventListener('load', complete, { once: true });
  img.addEventListener('error', complete, { once: true });
  if (img.complete) complete();
}
export function initializeImages(root = document) {
  if (!(root instanceof Element || root instanceof Document)) return;
  if (root.matches?.('[data-progressive-image]')) initialize(root);
  root.querySelectorAll('[data-progressive-image]').forEach(initialize);
}
export function releaseImages(root) {
  for (const frame of root.querySelectorAll('[data-progressive-image]')) {
    nearby?.unobserve(frame);
    queue.delete(frame);
  }
}
initializeImages();
