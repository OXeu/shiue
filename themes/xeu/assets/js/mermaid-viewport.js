const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const maxScale = 4;
const step = 1.25;

export function createMermaidViewport(element) {
  const viewport = element.querySelector('[data-mermaid-output]');
  const controls = element.querySelector('[data-mermaid-controls]');
  const zoomLabel = element.querySelector('[data-mermaid-zoom]');
  const pointers = new Map();
  let svg;
  let width = 1;
  let height = 1;
  let scale = 1;
  let x = 0;
  let y = 0;
  let autoFit = true;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let gesture;
  let dragged = false;

  const fitScale = () => Math.min(1, Math.max(1, viewport.clientWidth - 32) / width, Math.max(1, viewport.clientHeight - 32) / height);
  const minScale = () => Math.min(.1, fitScale());
  const center = () => ({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
  const localPoint = event => {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left - viewport.clientLeft, y: event.clientY - rect.top - viewport.clientTop };
  };

  function paint() {
    if (!svg) return;
    scale = clamp(scale, minScale(), maxScale);
    // 拖到边缘时仍留一部分图在视口内，避免整张图被拖丢。
    const visibleX = Math.min(48, width * scale / 2);
    const visibleY = Math.min(48, height * scale / 2);
    x = clamp(x, visibleX - width * scale, viewport.clientWidth - visibleX);
    y = clamp(y, visibleY - height * scale, viewport.clientHeight - visibleY);
    svg.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    controls.querySelector('[data-mermaid-action="out"]').disabled = scale <= minScale() + .00001;
    controls.querySelector('[data-mermaid-action="in"]').disabled = scale >= maxScale - .00001;
  }

  function fit() {
    autoFit = true;
    scale = fitScale();
    x = (viewport.clientWidth - width * scale) / 2;
    y = (viewport.clientHeight - height * scale) / 2;
    paint();
  }

  function zoom(nextScale, point = center()) {
    autoFit = false;
    nextScale = clamp(nextScale, minScale(), maxScale);
    x = point.x - (point.x - x) * nextScale / scale;
    y = point.y - (point.y - y) * nextScale / scale;
    scale = nextScale;
    paint();
  }

  function metrics() {
    const [first, second = first] = pointers.values();
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      distance: Math.hypot(second.x - first.x, second.y - first.y),
    };
  }

  function beginGesture() {
    gesture = pointers.size ? { ...metrics(), originX: x, originY: y, scale } : null;
    viewport.classList.toggle('is-dragging', pointers.size > 0);
  }

  function endPointer(event) {
    if (!pointers.delete(event.pointerId)) return;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    beginGesture();
  }

  function cancelGesture() {
    const ids = [...pointers.keys()];
    pointers.clear();
    ids.forEach(id => { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); });
    beginGesture();
  }

  controls.addEventListener('click', event => {
    const action = event.target.closest('[data-mermaid-action]')?.dataset.mermaidAction;
    if (!action) return;
    cancelGesture();
    if (action === 'fit') fit();
    else zoom(action === 'actual' ? 1 : scale * (action === 'in' ? step : 1 / step));
  });
  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    zoom(scale * Math.exp(-clamp(event.deltaY * unit, -250, 250) * .005), localPoint(event));
  }, { passive: false });
  viewport.addEventListener('dblclick', event => {
    if (event.target.closest('a')) return;
    event.preventDefault();
    zoom(scale * (event.shiftKey ? .5 : 2), localPoint(event));
  });
  viewport.addEventListener('pointerdown', event => {
    if ((event.pointerType === 'mouse' && event.button !== 0) || event.target.closest('a')) return;
    if (!pointers.size) dragged = false;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    pointers.set(event.pointerId, localPoint(event));
    viewport.setPointerCapture(event.pointerId);
    beginGesture();
  });
  viewport.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, localPoint(event));
    const current = metrics();
    if (Math.hypot(current.x - gesture.x, current.y - gesture.y) > 3 || pointers.size > 1) dragged = true;
    autoFit = false;
    scale = pointers.size > 1 && gesture.distance > 0
      ? clamp(gesture.scale * current.distance / gesture.distance, minScale(), maxScale)
      : gesture.scale;
    x = current.x - (gesture.x - gesture.originX) * scale / gesture.scale;
    y = current.y - (gesture.y - gesture.originY) * scale / gesture.scale;
    paint();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(event, endPointer);
  viewport.addEventListener('click', event => {
    if (dragged) { event.preventDefault(); event.stopPropagation(); dragged = false; }
  }, true);
  viewport.addEventListener('dragstart', event => event.preventDefault());
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey) return;
    const pan = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] }[event.key];
    if (!pan && !['+', '=', '-', '_', '0', '1', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (pan) { autoFit = false; x += pan[0]; y += pan[1]; paint(); }
    else if (event.key === '0' || event.key === 'Home') fit();
    else zoom(event.key === '1' ? 1 : scale * (['+', '='].includes(event.key) ? step : 1 / step));
  });
  window.addEventListener('blur', cancelGesture);
  window.addEventListener('pagehide', cancelGesture);

  function resize() {
    if (!svg || !viewport.clientWidth || !viewport.clientHeight) return;
    if (viewportWidth === viewport.clientWidth && viewportHeight === viewport.clientHeight) return;
    cancelGesture();
    if (autoFit) fit();
    else {
      x += (viewport.clientWidth - viewportWidth) / 2;
      y += (viewport.clientHeight - viewportHeight) / 2;
      paint();
    }
    viewportWidth = viewport.clientWidth;
    viewportHeight = viewport.clientHeight;
  }
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(viewport);
  else window.addEventListener('resize', resize);

  return {
    update(diagram) {
      cancelGesture();
      svg = diagram;
      width = diagram.viewBox.baseVal.width || Number(diagram.getAttribute('width')) || 1;
      height = diagram.viewBox.baseVal.height || Number(diagram.getAttribute('height')) || 1;
      Object.assign(svg.style, { width: `${width}px`, height: `${height}px`, maxWidth: 'none' });
      viewport.classList.add('is-interactive');
      controls.hidden = false;
      element.querySelector('[data-mermaid-hint]').hidden = false;
      viewportWidth = viewport.clientWidth;
      viewportHeight = viewport.clientHeight;
      if (autoFit) fit();
      else paint();
    },
  };
}
