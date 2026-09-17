(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const applyMode = preference => {
    root.dataset.colorPreference = preference;
    root.dataset.colorMode = preference === 'auto' ? (media.matches ? 'dark' : 'light') : preference;
    document.querySelectorAll('button[data-color-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.colorMode === preference));
    });
  };
  applyMode(root.dataset.colorPreference || 'light');
  const appearance = document.querySelector('[data-appearance]');
  if (appearance) appearance.hidden = false;
  document.querySelectorAll('button[data-color-mode]').forEach(button => {
    button.addEventListener('click', () => {
      applyMode(button.dataset.colorMode);
      try { localStorage.setItem('xeu-color-mode', button.dataset.colorMode); } catch { /* 本次页面仍可切换。 */ }
    });
  });
  media.addEventListener('change', () => applyMode(root.dataset.colorPreference));
  window.addEventListener('storage', event => {
    if (event.key === 'xeu-color-mode' || event.key === null) {
      applyMode(['light', 'dark', 'auto'].includes(event.newValue) ? event.newValue : 'light');
    }
  });
  const header = document.querySelector('.site-header');
  const navigation = header.querySelector('.site-navigation');
  const navToggle = navigation?.querySelector('.site-nav-toggle');
  const nav = navigation?.querySelector('.site-nav');
  if (navToggle && nav) {
    const mobileNav = matchMedia('(max-width: 600px)');
    const setNavOpen = open => {
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    };
    navToggle.hidden = false;
    navigation.classList.add('is-menu-ready');
    navToggle.addEventListener('click', () => {
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', event => {
      if (event.target.closest('a')) setNavOpen(false);
    });
    document.addEventListener('click', event => {
      if (!navigation.contains(event.target)) setNavOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || navToggle.getAttribute('aria-expanded') !== 'true') return;
      event.preventDefault();
      setNavOpen(false);
      navToggle.focus({ preventScroll: true });
    });
    navigation.addEventListener('focusout', event => {
      if (navigation.contains(event.relatedTarget)) return;
      // CSS 断点可能先隐藏链接，再触发媒体查询事件。
      const restoreFocus = mobileNav.matches && nav.contains(event.target) &&
        !event.relatedTarget && !nav.getClientRects().length && document.hasFocus();
      setNavOpen(false);
      if (restoreFocus) navToggle.focus({ preventScroll: true });
    });
    mobileNav.addEventListener('change', () => {
      const restoreFocus = mobileNav.matches && nav.contains(document.activeElement);
      setNavOpen(false);
      if (restoreFocus) navToggle.focus({ preventScroll: true });
    });
    window.addEventListener('pagehide', () => setNavOpen(false));
  }
  let wasScrolled;
  const updateHeader = () => {
    const scrolled = scrollY > 24;
    if (scrolled === wasScrolled) return;
    header.classList.toggle('is-scrolled', scrolled);
    wasScrolled = scrolled;
  };
  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();
  document.querySelectorAll('.copy-code').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent);
        button.textContent = '已复制';
      } catch { button.textContent = '复制失败，请手动选择'; }
      setTimeout(() => { button.textContent = '复制'; }, 2200);
    });
  });
  const comments = document.querySelector('[data-comments]');
  comments?.querySelector('[data-load-comments]').addEventListener('click', async event => {
    const button = event.currentTarget;
    const status = comments.querySelector('[role="status"]');
    button.disabled = true;
    status.textContent = '正在加载评论…';
    try {
      if (!window.twikoo) await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/twikoo@1.5.11/dist/twikoo.all.min.js';
        const timeout = setTimeout(() => { script.remove(); reject(new Error('评论加载超时')); }, 15000);
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('评论加载失败')); };
        document.head.append(script);
      });
      await window.twikoo.init({ envId: comments.dataset.env, el: '#twikoo', lang: comments.dataset.lang, path: comments.dataset.path });
      button.hidden = true;
      button.closest('.comment-loader').hidden = true;
      status.textContent = '';
    } catch { status.textContent = '评论暂时无法加载，请稍后重试。'; }
    finally { button.disabled = false; }
  });
  if ('IntersectionObserver' in window) {
    const links = [...document.querySelectorAll('.desktop-toc a')];
    const headings = links.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1)))).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach(link => {
        if (decodeURIComponent(link.hash.slice(1)) === visible.target.id) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-96px 0px -65% 0px' });
    headings.forEach(heading => observer.observe(heading));
  }
})();
