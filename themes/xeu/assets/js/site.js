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
  applyMode(root.dataset.colorPreference || 'auto');
  document.querySelectorAll('button[data-color-mode]').forEach(button => {
    button.addEventListener('click', () => {
      applyMode(button.dataset.colorMode);
      try { localStorage.setItem('xeu-color-mode', button.dataset.colorMode); } catch { /* 本次页面仍可切换。 */ }
    });
  });
  media.addEventListener('change', () => applyMode(root.dataset.colorPreference));
  window.addEventListener('storage', event => {
    if (event.key === 'xeu-color-mode') applyMode(['light', 'dark'].includes(event.newValue) ? event.newValue : 'auto');
  });
  const header = document.querySelector('.site-header');
  const updateHeader = () => header.classList.toggle('is-scrolled', scrollY > 24);
  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();
  document.addEventListener('error', event => {
    if (event.target instanceof HTMLImageElement && event.target.closest('.card-cover')) event.target.closest('.card-cover').hidden = true;
  }, true);
  document.querySelectorAll('.card-cover img').forEach(img => {
    if (img.complete && !img.naturalWidth) img.closest('.card-cover').hidden = true;
  });
  document.querySelectorAll('.copy-code').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent);
        button.textContent = '已复制';
      } catch { button.textContent = '复制失败，请手动选择'; }
      setTimeout(() => { button.textContent = '复制'; }, 2200);
    });
  });
  const zoomImages = document.querySelectorAll('[data-zoomable]');
  if (zoomImages.length) {
    const dialog = document.createElement('dialog');
    dialog.className = 'image-dialog';
    dialog.setAttribute('aria-label', '图片预览');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    const image = document.createElement('img');
    dialog.append(close, image);
    document.body.append(dialog);
    let previousOverflow;
    const showImage = original => {
      image.src = original.currentSrc || original.src;
      image.alt = original.alt;
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
    };
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { document.body.style.overflow = previousOverflow; });
    zoomImages.forEach(img => {
      if (img.closest('a')) return;
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `放大图片：${img.alt || '文章配图'}`);
      img.addEventListener('click', () => showImage(img));
      img.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showImage(img); }
      });
    });
  }
  const comments = document.querySelector('[data-comments]');
  comments?.querySelector('[data-load-comments]').addEventListener('click', async event => {
    const button = event.currentTarget;
    const status = comments.querySelector('[role="status"]');
    button.disabled = true;
    status.textContent = '正在加载评论…';
    try {
      if (!window.twikoo) await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/twikoo@1.6.44/dist/twikoo.all.min.js';
        const timeout = setTimeout(() => { script.remove(); reject(new Error('评论加载超时')); }, 15000);
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('评论加载失败')); };
        document.head.append(script);
      });
      await window.twikoo.init({ envId: comments.dataset.env, el: '#twikoo', lang: comments.dataset.lang, path: comments.dataset.path });
      button.hidden = true;
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
