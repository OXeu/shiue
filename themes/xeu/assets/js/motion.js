const preference = matchMedia('(prefers-reduced-motion: reduce)');
const active = new Map();
const pending = new Set();
const revealed = new WeakSet();
export const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const canAnimate = () => !preference.matches && !document.hidden;

export function cancelMotion(element) {
  const entry = active.get(element);
  if (!entry) return;
  active.delete(element);
  element.style.willChange = entry.previous;
  entry.animation.cancel();
}

// 动画交给浏览器合成；只在动画期间为少量可见元素提示图层提升。
export function animateElement(element, keyframes, options = {}) {
  cancelMotion(element);
  if (!canAnimate() || !element.animate) return Promise.resolve(false);
  const previous = element.style.willChange;
  element.style.willChange = [...new Set(keyframes.flatMap(frame => Object.keys(frame)))].filter(key => key === 'transform' || key === 'opacity').join(', ');
  const animation = element.animate(keyframes, { duration: 300, easing, fill: 'backwards', ...options });
  const entry = { animation, previous };
  active.set(element, entry);
  return animation.finished.then(() => true, () => false).finally(() => {
    if (active.get(element) === entry) {
      element.style.willChange = previous;
      if (options.fill !== 'forwards' && options.fill !== 'both') {
        active.delete(element);
        animation.cancel();
      }
    }
  });
}

function reveal(card, delay = 0) {
  pending.delete(card);
  card.classList.remove('reveal-pending');
  observer?.unobserve(card);
  animateElement(card, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 340, delay });
}
const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  entries.filter(entry => entry.isIntersecting).forEach((entry, index) => reveal(entry.target, Math.min(index * 32, 96)));
}, { threshold: 0.01 }) : null;

export function revealCards(cards) {
  for (const card of cards) {
    if (revealed.has(card)) continue;
    revealed.add(card);
    if (!observer || !canAnimate()) continue;
    // 首屏内容已经随 HTML 出现；再次把它设为透明会把入场动画计入 LCP。
    // 只为尚未进入视口的卡片保留滚动揭示效果。
    const bounds = card.getBoundingClientRect();
    if (bounds.top < innerHeight && bounds.bottom > 0) continue;
    pending.add(card);
    card.classList.add('reveal-pending');
    observer.observe(card);
  }
}

export function forgetCard(card) {
  pending.delete(card);
  observer?.unobserve(card);
  card.classList.remove('reveal-pending');
  cancelMotion(card);
}

function finishMotion() {
  for (const { animation } of active.values()) {
    try { animation.finish(); } catch { animation.cancel(); }
  }
  for (const card of pending) {
    card.classList.remove('reveal-pending');
    observer?.unobserve(card);
  }
  pending.clear();
}
preference.addEventListener('change', () => { if (preference.matches) finishMotion(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) finishMotion(); });
window.addEventListener('pagehide', finishMotion);
document.addEventListener('focusin', event => {
  const card = event.target.closest?.('.post-card');
  if (card && pending.has(card)) {
    forgetCard(card);
  }
});
