(() => {
  // 按时间顺序逐张放入最短列，DOM 与键盘阅读顺序保持一致。
  document.querySelectorAll('[data-masonry]').forEach(container => {
    let frame = 0;
    let cards = [];
    let observer;
    const layout = () => {
      frame = 0;
      const width = container.clientWidth;
      if (!width) return;
      const styles = getComputedStyle(container);
      const gap = parseFloat(styles.gap) || 16;
      const minimum = parseFloat(styles.getPropertyValue('--card-min')) || 260;
      const columns = Math.max(1, Math.min(3, Math.floor((width + gap) / (minimum + gap))));
      const cardWidth = (width - gap * (columns - 1)) / columns;
      const heights = Array(columns).fill(0);
      container.classList.add('is-masonry');
      cards.forEach(card => {
        card.style.width = `${cardWidth}px`;
        card.style.position = 'absolute';
      });
      const sizes = cards.map(card => card.getBoundingClientRect().height);
      cards.forEach((card, index) => {
        const column = heights.indexOf(Math.min(...heights));
        card.style.left = `${column * (cardWidth + gap)}px`;
        card.style.top = `${heights[column]}px`;
        heights[column] += sizes[index] + gap;
      });
      container.style.height = `${Math.max(0, ...heights) - (cards.length ? gap : 0)}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(layout);
    };
    const observe = () => {
      observer?.disconnect();
      cards = Array.from(container.children);
      observer?.observe(container);
      cards.forEach(card => observer?.observe(card));
      schedule();
    };
    if ('ResizeObserver' in window) observer = new ResizeObserver(schedule);
    new MutationObserver(observe).observe(container, { childList: true });
    container.addEventListener('load', schedule, true);
    container.addEventListener('error', schedule, true);
    window.addEventListener('resize', schedule, { passive: true });
    document.fonts?.ready.then(schedule);
    observe();
  });
})();
