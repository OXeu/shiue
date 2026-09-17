const embeds = [...document.querySelectorAll('[data-x-embed]')];
let widgetsPromise;

function loadWidgets() {
  if (window.twttr?.widgets?.createTweet) return Promise.resolve(window.twttr.widgets);
  if (widgetsPromise) return widgetsPromise;
  widgetsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const finish = error => {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else resolve(window.twttr.widgets);
    };
    const timeout = setTimeout(() => finish(new Error('X 嵌入脚本加载超时')), 15000);
    script.src = 'https://platform.twitter.com/widgets.js';
    script.async = true;
    script.onload = () => {
      if (window.twttr?.widgets?.createTweet) finish();
      else finish(new Error('X 嵌入组件不可用'));
    };
    script.onerror = () => finish(new Error('X 嵌入脚本加载失败'));
    document.head.append(script);
  }).catch(error => {
    widgetsPromise = undefined;
    throw error;
  });
  return widgetsPromise;
}

async function withTimeout(promise) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('X 帖子加载超时')), 15000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

if (embeds.length) {
  const root = document.documentElement;
  const states = embeds.map(element => ({ element, active: false, generation: 0, theme: '' }));
  const render = async state => {
    const theme = root.dataset.colorMode === 'dark' ? 'dark' : 'light';
    if (!state.active || state.theme === theme) return;
    state.theme = theme;
    const generation = ++state.generation;
    const fallback = state.element.querySelector('.x-embed-fallback');
    let host;
    try {
      const widgets = await loadWidgets();
      if (generation !== state.generation || !state.element.isConnected) return;
      host = document.createElement('div');
      host.className = 'x-embed-frame is-pending';
      state.element.prepend(host);
      const result = await withTimeout(widgets.createTweet(state.element.dataset.xEmbed, host, {
        theme, dnt: true, lang: 'zh-cn', align: 'center', conversation: 'none',
      }));
      if (generation !== state.generation || !state.element.isConnected) {
        host.remove();
        return;
      }
      if (!result) throw new Error('X 帖子不可用');
      state.frame?.remove();
      state.frame = host;
      host.classList.remove('is-pending');
      fallback.hidden = true;
    } catch {
      host?.remove();
      if (generation !== state.generation) return;
      state.frame?.remove();
      state.frame = undefined;
      fallback.hidden = false;
      state.theme = '';
    }
  };
  if ('IntersectionObserver' in window) {
    const byElement = new Map(states.map(state => [state.element, state]));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const state = byElement.get(entry.target);
        state.active = true;
        render(state);
      }
    }, { rootMargin: '400px' });
    states.forEach(state => observer.observe(state.element));
  } else {
    states.forEach(state => { state.active = true; render(state); });
  }
  new MutationObserver(() => states.forEach(render))
    .observe(root, { attributes: true, attributeFilter: ['data-color-mode'] });
}
