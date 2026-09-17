import { animateElement, cancelMotion, canAnimate } from './motion.js';

const sources = [...document.querySelectorAll('[data-zoomable]')].filter(img => !img.closest('a'));
if (sources.length) {
  const dialog = document.createElement('dialog');
  dialog.className = 'image-dialog';
  dialog.setAttribute('aria-label', '图片预览');
  const scrim = document.createElement('div');
  scrim.className = 'image-dialog-scrim';
  const stage = document.createElement('div');
  stage.className = 'image-dialog-stage';
  const thumbnail = document.createElement('img');
  thumbnail.className = 'preview-thumbnail';
  thumbnail.alt = '';
  thumbnail.setAttribute('aria-hidden', 'true');
  const original = document.createElement('img');
  original.className = 'preview-original';
  original.decoding = 'async';
  const close = document.createElement('button');
  close.className = 'image-dialog-close';
  close.type = 'button';
  close.textContent = '关闭';
  const status = document.createElement('p');
  status.className = 'image-dialog-status';
  status.setAttribute('role', 'status');
  stage.append(thumbnail, original);
  dialog.append(scrim, stage, close, status);
  document.body.append(dialog);
  let source;
  let target;
  let phase = 'closed';
  let sequence = 0;
  let previousOverflow = '';
  let previousGutter = '';
  let previousPadding = '';
  let resizeFrame = 0;
  const setPhase = value => { phase = value; dialog.dataset.state = value; };
  const position = () => {
    const width = Number(source.getAttribute('width')) || source.naturalWidth || source.width || 1;
    const height = Number(source.getAttribute('height')) || source.naturalHeight || source.height || 1;
    const viewportWidth = dialog.clientWidth;
    const viewportHeight = dialog.clientHeight;
    const scale = Math.min((viewportWidth - 40) / width, (viewportHeight - 128) / height, 1);
    target = { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
    target.x = (viewportWidth - target.width) / 2;
    target.y = Math.max(64, (viewportHeight - target.height) / 2);
    Object.assign(stage.style, { left: `${target.x}px`, top: `${target.y}px`, width: `${target.width}px`, height: `${target.height}px` });
  };
  const transformTo = rect => `translate(${rect.left - target.x}px, ${rect.top - target.y}px) scale(${rect.width / target.width}, ${rect.height / target.height})`;
  const cleanup = () => {
    if (phase === 'closed') return;
    sequence++;
    setPhase('closed');
    [stage, scrim, close, status, thumbnail, original].forEach(cancelMotion);
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    source?.classList.remove('is-preview-source');
    document.documentElement.style.overflow = previousOverflow;
    document.documentElement.style.scrollbarGutter = previousGutter;
    document.body.style.paddingRight = previousPadding;
    dialog.classList.remove('has-original');
    original.onload = original.onerror = null;
    original.removeAttribute('src');
    thumbnail.removeAttribute('src');
    source?.focus({ preventScroll: true });
  };
  const hide = async () => {
    if (phase === 'closed' || phase === 'closing') return;
    const token = ++sequence;
    const currentTransform = getComputedStyle(stage).transform;
    const currentOpacity = getComputedStyle(scrim).opacity;
    const rect = source.getBoundingClientRect();
    const returnToSource = source.isConnected && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight;
    setPhase('closing');
    // 起止位置只测量一次，开合过程只插值 transform 和 opacity。
    const movement = animateElement(stage, [
      { transform: currentTransform, opacity: 1 },
      { transform: returnToSource ? transformTo(rect) : currentTransform, opacity: returnToSource ? 1 : 0 },
    ], { duration: 240, fill: 'forwards' });
    animateElement(scrim, [{ opacity: currentOpacity }, { opacity: 0 }], { duration: 220, fill: 'forwards' });
    animateElement(close, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    animateElement(status, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    await movement;
    if (token !== sequence) return;
    dialog.close();
    cleanup();
  };
  const show = img => {
    if (phase !== 'closed') return;
    source = img;
    const token = ++sequence;
    const rect = source.getBoundingClientRect();
    previousOverflow = document.documentElement.style.overflow;
    previousGutter = document.documentElement.style.scrollbarGutter;
    previousPadding = document.body.style.paddingRight;
    const scrollbarWidth = innerWidth - document.documentElement.clientWidth;
    const bodyPadding = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
    const placeholder = source.closest('[data-progressive-image]')?.querySelector('canvas');
    thumbnail.src = source.complete && source.naturalWidth ? source.currentSrc : (placeholder?.toDataURL() || source.currentSrc || source.src);
    original.alt = source.alt;
    status.textContent = '正在加载原图…';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.scrollbarGutter = 'auto';
    document.body.style.paddingRight = `${bodyPadding + scrollbarWidth}px`;
    dialog.showModal();
    close.focus({ preventScroll: true });
    position();
    setPhase('opening');
    source.classList.add('is-preview-source');
    const opening = animateElement(stage, [{ transform: transformTo(rect) }, { transform: 'none' }], { duration: 360 });
    animateElement(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
    animateElement(close, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 100 });
    animateElement(status, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 100 });
    opening.then(() => { if (token === sequence && phase === 'opening') setPhase('open'); });
    original.onload = async () => {
      await original.decode().catch(() => {});
      if (token !== sequence || phase === 'closing' || phase === 'closed') return;
      status.textContent = '';
      dialog.classList.add('has-original');
      animateElement(original, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
      animateElement(thumbnail, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 });
    };
    original.onerror = () => {
      if (token === sequence && phase !== 'closed') status.textContent = '原图暂时无法加载，当前显示预览图。';
    };
    original.src = source.dataset.original || source.currentSrc || source.src;
    if (!canAnimate()) setPhase('open');
  };
  close.addEventListener('click', hide);
  dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
  dialog.addEventListener('click', event => { if (event.target === dialog || event.target === scrim) hide(); });
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
  window.addEventListener('resize', () => {
    if (phase === 'closed' || phase === 'closing' || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (phase === 'closed' || phase === 'closing') return;
      cancelMotion(stage);
      position();
      setPhase('open');
    });
  }, { passive: true });
  window.addEventListener('pagehide', () => { if (dialog.open) { dialog.close(); cleanup(); } });
  for (const img of sources) {
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `放大图片：${img.alt || '文章配图'}`);
    img.addEventListener('click', () => show(img));
    img.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(img); }
    });
  }
}
