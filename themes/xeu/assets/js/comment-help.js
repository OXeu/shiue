export function setupCommentHelp(editor) {
  let active;
  let pinned = false;
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!active) return;
    const { tooltip } = active;
    if (tooltip.matches('[popover]')) tooltip.hidePopover();
    tooltip.hidden = true;
    active = undefined;
    pinned = false;
  };
  const show = (button, tooltip) => {
    clearTimeout(timer);
    if (active?.button === button) return;
    dismiss();
    active = { button, tooltip };
    tooltip.hidden = false;
    if (typeof tooltip.showPopover === 'function') {
      tooltip.setAttribute('popover', 'manual');
      tooltip.showPopover({ source: button });
    }
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 12;
    const top = (viewport?.offsetTop || 0) + 12;
    const right = left + (viewport?.width || document.documentElement.clientWidth) - 24;
    const bottom = top + (viewport?.height || innerHeight) - 24;
    tooltip.style.maxWidth = `${Math.min(300, right - left)}px`;
    const anchor = button.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    const y = anchor.bottom + 6 + bounds.height <= bottom ? anchor.bottom + 6 : anchor.top - 6 - bounds.height;
    tooltip.style.left = `${Math.max(left, Math.min(anchor.left, right - bounds.width))}px`;
    tooltip.style.top = `${Math.max(top, Math.min(y, bottom - bounds.height))}px`;
  };
  const leave = () => {
    clearTimeout(timer);
    if (!pinned && document.activeElement !== active?.button) timer = setTimeout(dismiss, 120);
  };
  for (const button of editor.querySelectorAll('[data-comment-help]')) {
    const tooltip = editor.querySelector(`#${button.dataset.commentHelp}`);
    button.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') show(button, tooltip); });
    button.addEventListener('pointerleave', leave);
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) show(button, tooltip); });
    button.addEventListener('blur', dismiss);
    button.addEventListener('click', () => {
      if (active?.button === button && pinned) dismiss();
      else { show(button, tooltip); pinned = true; }
    });
    tooltip.addEventListener('pointerenter', () => clearTimeout(timer));
    tooltip.addEventListener('pointerleave', leave);
  }
  editor.addEventListener('keydown', event => {
    if (active && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (active && !active.button.contains(event.target) && !active.tooltip.contains(event.target)) dismiss();
  });
  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('resize', dismiss);
  window.visualViewport?.addEventListener('resize', dismiss);
  window.visualViewport?.addEventListener('scroll', dismiss);
  return { dismiss };
}
