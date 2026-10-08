const preference = matchMedia('(prefers-reduced-motion: reduce)');
const active = new Map();
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

function finishMotion() {
  for (const { animation } of active.values()) {
    try { animation.finish(); } catch { animation.cancel(); }
  }
}
preference.addEventListener('change', () => { if (preference.matches) finishMotion(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) finishMotion(); });
window.addEventListener('pagehide', finishMotion);
