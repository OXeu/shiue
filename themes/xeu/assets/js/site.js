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
  const navToggle = header?.querySelector('.site-nav-toggle');
  const nav = header?.querySelector('.site-nav');
  if (navToggle && nav) {
    const mobileNav = matchMedia('(max-width: 600px)');
    const setNavOpen = open => {
      open = mobileNav.matches && open;
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
      nav.inert = mobileNav.matches && !open;
      nav.setAttribute('aria-hidden', String(nav.inert));
    };
    navToggle.hidden = false;
    header.classList.add('is-menu-ready');
    setNavOpen(false);
    navToggle.addEventListener('click', () => {
      header.classList.add('is-menu-animated');
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', event => {
      if (event.target.closest('a')) setNavOpen(false);
    });
    document.addEventListener('click', event => {
      if (!navToggle.contains(event.target) && !nav.contains(event.target)) setNavOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || navToggle.getAttribute('aria-expanded') !== 'true') return;
      event.preventDefault();
      setNavOpen(false);
      navToggle.focus({ preventScroll: true });
    });
    header.addEventListener('focusout', event => {
      if (navToggle.contains(event.relatedTarget) || nav.contains(event.relatedTarget)) return;
      // CSS 断点可能先隐藏链接，再触发媒体查询事件。
      const restoreFocus = mobileNav.matches && nav.contains(event.target) &&
        !event.relatedTarget && getComputedStyle(nav).visibility === 'hidden' && document.hasFocus();
      setNavOpen(false);
      if (restoreFocus) navToggle.focus({ preventScroll: true });
    });
    mobileNav.addEventListener('change', () => {
      const restoreFocus = mobileNav.matches && nav.contains(document.activeElement);
      header.classList.remove('is-menu-animated');
      setNavOpen(false);
      if (restoreFocus) navToggle.focus({ preventScroll: true });
    });
    window.addEventListener('pagehide', () => {
      header.classList.remove('is-menu-animated');
      setNavOpen(false);
    });
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
      const label = button.dataset.copyLabel || '代码';
      try {
        await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent);
        button.textContent = '已复制';
        button.setAttribute('aria-label', `${label}已复制`);
      } catch {
        button.textContent = '复制失败，请手动选择';
        button.setAttribute('aria-label', `${label}复制失败，请手动选择`);
      }
      setTimeout(() => {
        button.textContent = '复制';
        button.setAttribute('aria-label', `复制${label}`);
      }, 2200);
    });
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
