import { animateElement, revealCards, forgetCard } from './motion.js';

document.querySelectorAll('[data-masonry]').forEach(container => {
  const records = new Map();
  let cards = [];
  let frame = 0;
  let previousWidth = 0;
  let previousHeight = -1;
  let observer;
  let settings;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(layout); };
  function layout() {
    frame = 0;
    const width = container.clientWidth;
    if (!width) return;
    const widthChanged = Math.abs(width - previousWidth) > .5;
    if (!settings || widthChanged) {
      const styles = getComputedStyle(container);
      settings = {
        gap: parseFloat(styles.gap) || 16,
        minimum: parseFloat(styles.getPropertyValue('--card-min')) || 260,
        maximum: parseInt(styles.getPropertyValue('--columns-max'), 10) || 4,
      };
    }
    previousWidth = width;
    const { gap, minimum, maximum } = settings;
    const columns = Math.max(1, Math.min(maximum, Math.floor((width + gap) / (minimum + gap))));
    const cardWidth = (width - gap * (columns - 1)) / columns;
    const heights = Array(columns).fill(0);
    const measure = [];
    container.classList.add('is-masonry');
    // 批量写入宽度后只测量受影响的卡片；已预留尺寸的图片加载不触发重排。
    for (const card of cards) {
      const record = records.get(card);
      if (record.width !== cardWidth) {
        card.style.width = `${cardWidth}px`;
        card.style.position = 'absolute';
        record.width = cardWidth;
        measure.push(card);
      } else if (!record.height) measure.push(card);
    }
    for (const card of measure) records.get(card).height = card.getBoundingClientRect().height;
    for (const card of cards) {
      const record = records.get(card);
      const column = heights.indexOf(Math.min(...heights));
      const x = column * (cardWidth + gap);
      const y = heights[column];
      const moved = record.placed && (Math.abs(x - record.x) > .5 || Math.abs(y - record.y) > .5);
      if (record.x !== x) card.style.left = `${x}px`;
      if (record.y !== y) card.style.top = `${y}px`;
      if (moved && !card.classList.contains('reveal-pending')) {
        animateElement(card, [{ transform: `translate(${record.x - x}px, ${record.y - y}px)` }, { transform: 'none' }], { duration: 260 });
      }
      Object.assign(record, { x, y, placed: true });
      heights[column] += record.height + gap;
    }
    const height = Math.max(0, ...heights) - (cards.length ? gap : 0);
    if (height !== previousHeight) {
      container.style.height = `${height}px`;
      previousHeight = height;
    }
    revealCards(cards);
  }
  if ('ResizeObserver' in window) {
    observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === container) {
          if (Math.abs(entry.contentRect.width - previousWidth) > .5) changed = true;
          continue;
        }
        const record = records.get(entry.target);
        const size = entry.borderBoxSize?.[0] || entry.borderBoxSize;
        const height = size?.blockSize ?? entry.target.offsetHeight;
        if (record && Math.abs(height - record.height) > .5) {
          record.height = height;
          changed = true;
        }
      }
      if (changed) schedule();
    });
    observer.observe(container);
  } else {
    const invalidate = () => { for (const record of records.values()) record.height = 0; schedule(); };
    window.addEventListener('resize', invalidate, { passive: true });
    container.addEventListener('load', invalidate, true);
    document.fonts?.ready.then(invalidate);
  }
  const observe = () => {
    cards = Array.from(container.children);
    for (const card of records.keys()) {
      if (!cards.includes(card)) {
        observer?.unobserve(card);
        forgetCard(card);
        records.delete(card);
      }
    }
    for (const card of cards) {
      if (records.has(card)) continue;
      records.set(card, { width: 0, height: 0, placed: false });
      observer?.observe(card);
    }
    schedule();
  };
  new MutationObserver(observe).observe(container, { childList: true });
  observe();
});
