import { animateElement, cancelMotion, canAnimate } from './motion.js';

const preference = matchMedia('(prefers-reduced-motion: reduce)');
const pending = new Set();
const revealed = new WeakSet();

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

function finishReveals() {
  for (const card of pending) {
    card.classList.remove('reveal-pending');
    observer?.unobserve(card);
  }
  pending.clear();
}
preference.addEventListener('change', () => { if (preference.matches) finishReveals(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) finishReveals(); });
window.addEventListener('pagehide', finishReveals);
document.addEventListener('focusin', event => {
  const card = event.target.closest?.('.post-card');
  if (card && pending.has(card)) {
    forgetCard(card);
  }
});
