// 在首次绘制前注册跨文档事件；保留原生链接、历史记录和新标签页行为。
(() => {
  if (!('onpageswap' in window) || !('onpagereveal' in window)) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let active;
  const address = value => {
    if (!value) return '';
    const url = new URL(value, location.href);
    return url.origin === location.origin ? `${url.pathname}${url.search}` : '';
  };
  const visible = element => {
    if (!element) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
  };
  const cardParts = url => {
    const link = [...document.querySelectorAll('.card-title a')].find(link => address(link.href) === address(url));
    const card = link?.closest('.post-card');
    if (!visible(card)) return null;
    return [card, card.querySelector('.card-title'), card.querySelector('.card-cover')];
  };
  const articleParts = () => {
    const article = document.querySelector('[data-article]');
    if (!article) return null;
    const heading = article.querySelector('.article-heading');
    if (!visible(heading)) return null;
    const image = [...article.querySelectorAll('.prose img[data-original]')]
      .find(img => address(img.dataset.original) === address(article.dataset.articleCover));
    const cover = image?.closest('.content-image');
    return [heading, heading.querySelector('h1'), visible(cover) ? cover : null];
  };
  const clear = state => {
    if (active !== state) return;
    state.elements.forEach(([element, name]) => { element.style.viewTransitionName = name; });
    delete root.dataset.articleTransition;
    delete root.dataset.articleTransitionCover;
    active = undefined;
  };
  const start = (transition, parts, direction) => {
    if (!parts) return;
    if (active) clear(active);
    const state = { transition, elements: [] };
    active = state;
    root.dataset.articleTransition = direction;
    root.dataset.articleTransitionCover = String(Boolean(parts[2]));
    parts.forEach((element, index) => {
      if (!element) return;
      // 键盘快速打开尚在入场的卡片时，也必须取得完整快照。
      element.getAnimations().forEach(animation => { try { animation.finish(); } catch { animation.cancel(); } });
      element.classList.remove('reveal-pending');
      state.elements.push([element, element.style.viewTransitionName]);
      element.style.viewTransitionName = ['article-panel', 'article-title', 'article-cover'][index];
    });
    transition.ready.catch(() => {});
    transition.finished.then(() => clear(state), () => clear(state));
  };
  window.addEventListener('pageswap', event => {
    if (!event.viewTransition || reduced.matches) return;
    const target = event.activation?.entry?.url;
    if (!target || !address(target) || address(target) === address(location.href)) return;
    const card = cardParts(target);
    if (card) start(event.viewTransition, card, 'open');
    else if (event.activation.navigationType === 'traverse') start(event.viewTransition, articleParts(), 'close');
  });
  window.addEventListener('pagereveal', event => {
    if (!event.viewTransition || reduced.matches) return;
    const activation = window.navigation?.activation;
    const from = activation?.from?.url;
    if (!from || !address(from) || address(from) === address(location.href)) return;
    const article = articleParts();
    if (article) start(event.viewTransition, article, 'open');
    else start(event.viewTransition, cardParts(from), 'close');
  });
  reduced.addEventListener('change', () => {
    if (reduced.matches && active) {
      active.transition.skipTransition();
      clear(active);
    }
  });
})();
