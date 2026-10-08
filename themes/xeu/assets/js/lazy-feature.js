// Hugo separately fingerprints each feature. Wait for its CSS before running
// the module, and retain the first interaction until its handlers are ready.
function loadAsset(tag, url, integrity) {
  return new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    element.integrity = integrity;
    element.crossOrigin = 'anonymous';
    if (tag === 'link') { element.rel = 'stylesheet'; element.href = url; }
    else { element.type = 'module'; element.src = url; }
    element.onload = () => resolve(element);
    element.onerror = () => { element.remove(); reject(new Error('资源加载失败')); };
    document.head.append(element);
  });
}

export function deferFeature(name, selector, { prepare, onError, keyboard = false }) {
  const template = document.querySelector(`template[data-lazy-feature="${name}"]`);
  if (!template) return;
  const elements = [...document.querySelectorAll(selector)].filter(element => !element.closest('a'));
  let loading = false;
  let stylesheet;
  const activate = async event => {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (loading) return;
    loading = true;
    const element = event.currentTarget;
    element.setAttribute('aria-busy', 'true');
    try {
      const data = template.dataset;
      stylesheet ||= await loadAsset('link', data.stylesheet, data.stylesheetIntegrity);
      await loadAsset('script', data.script, data.integrity);
      for (const target of elements) {
        target.removeEventListener('click', activate, true);
        if (keyboard) target.removeEventListener('keydown', activate, true);
      }
      if (element.isConnected) element.click();
    } catch {
      onError?.(element);
    } finally {
      loading = false;
      element.removeAttribute('aria-busy');
    }
  };
  for (const element of elements) {
    prepare?.(element);
    element.addEventListener('click', activate, true);
    if (keyboard) element.addEventListener('keydown', activate, true);
  }
}
