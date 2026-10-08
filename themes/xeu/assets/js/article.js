(() => {
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
