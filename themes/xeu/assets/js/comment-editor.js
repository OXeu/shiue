import { setupCommentHelp } from './comment-help.js';

export function setupCommentEditor(form) {
  const section = form.closest('[data-comments]');
  const popover = form.closest('.comment-popover');
  const help = setupCommentHelp(popover);
  const triggers = [...section.querySelectorAll('[data-new-comment], [data-reply-id]')];
  const parent = form.elements.namedItem('parentId');
  const status = form.querySelector('[role="status"]');
  const feedback = form.querySelector('[data-comment-feedback]');
  const stateTitle = form.querySelector('[data-state-title]');
  const stateSymbol = form.querySelector('[data-state-symbol]');
  const done = form.querySelector('[data-comment-done]');
  const fields = form.querySelector('fieldset');
  const replyContext = form.querySelector('[data-reply-context]');
  const replyTarget = form.querySelector('[data-reply-target]');
  const nativePopover = typeof popover.showPopover === 'function';
  const drafts = new Map();
  let trigger;
  let open = false;
  let busy = false;
  let state = 'editing';
  let pending;
  let savedDraft;
  let frame;
  const key = () => `xeu-comment-draft:v1:${encodeURIComponent(form.dataset.path)}:${parent.value || 'root'}`;
  const storageFailed = () => {
    section.querySelector('[data-draft-note]').textContent = '浏览器未允许保存草稿，刷新或离开页面后草稿可能丢失。';
  };
  const removeDraft = () => {
    drafts.delete(key());
    try { localStorage.removeItem(key()); } catch { storageFailed(); }
  };
  const currentDraft = () => {
    const draft = { pending };
    for (const name of ['name', 'email', 'message']) draft[name] = form.elements.namedItem(name).value;
    draft.consent = form.elements.namedItem('consent').checked;
    return draft;
  };
  const saveDraft = () => {
    if (!trigger) return;
    const draft = currentDraft();
    const serialized = JSON.stringify(draft);
    // Closing, backgrounding or leaving an unchanged page must not resurrect
    // a draft deleted by another tab, or overwrite that tab's newer edits.
    if (serialized === savedDraft) return;
    savedDraft = serialized;
    if (!draft.name && !draft.email && !draft.message && !draft.consent) { removeDraft(); return; }
    drafts.set(key(), draft);
    try { localStorage.setItem(key(), serialized); } catch { storageFailed(); }
  };
  const readDraft = () => {
    let draft = drafts.get(key());
    try { draft = JSON.parse(localStorage.getItem(key())); } catch { storageFailed(); }
    return draft;
  };
  const loadDraft = () => {
    const draft = readDraft();
    if (draft) drafts.set(key(), draft);
    else drafts.delete(key());
    for (const name of ['name', 'email', 'message']) {
      form.elements.namedItem(name).value = typeof draft?.[name] === 'string' ? draft[name] : '';
    }
    form.elements.namedItem('consent').checked = draft?.consent === true;
    form.elements.namedItem('website').value = '';
    pending = draft?.pending;
    savedDraft = JSON.stringify(currentDraft());
  };
  const syncDraft = () => {
    if (trigger && !busy && state !== 'success') { loadDraft(); reposition(); }
  };
  const position = () => {
    if (!open) return;
    const viewport = window.visualViewport;
    const edge = 12;
    const gap = 8;
    const left = (viewport?.offsetLeft || 0) + edge;
    const top = (viewport?.offsetTop || 0) + edge;
    const right = left + (viewport?.width || document.documentElement.clientWidth) - edge * 2;
    const bottom = top + (viewport?.height || window.innerHeight) - edge * 2;
    const anchor = trigger.getBoundingClientRect();
    popover.style.width = `${Math.min(448, right - left)}px`;
    const below = Math.max(0, bottom - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - top - gap);
    const preferBelow = below >= Math.min(popover.scrollHeight + 2, bottom - top) || below >= above;
    popover.style.maxHeight = `${Math.min(bottom - top, preferBelow ? below : above)}px`;
    const bounds = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(left, Math.min(anchor.right - bounds.width, right - bounds.width))}px`;
    popover.style.top = `${Math.max(top, Math.min(preferBelow ? anchor.bottom + gap : anchor.top - gap - bounds.height, bottom - bounds.height))}px`;
  };
  const reposition = () => {
    cancelAnimationFrame(frame);
    if (open) frame = requestAnimationFrame(position);
  };
  const showState = (nextState, message = '') => {
    const previous = state;
    state = nextState;
    const overlay = state !== 'editing';
    help.dismiss();
    popover.classList.toggle('has-status', overlay);
    popover.setAttribute('aria-labelledby', overlay ? 'comment-state-title' : 'comment-editor-title');
    feedback.classList.toggle('comment-state-panel', overlay);
    feedback.dataset.state = state;
    fields.inert = overlay;
    stateTitle.hidden = stateSymbol.hidden = !overlay;
    stateTitle.textContent = { verifying: '浏览器验证', sending: '正在送交审核', success: '提交成功' }[state] || '';
    status.textContent = message;
    done.hidden = state !== 'success';
    if (overlay) {
      popover.scrollTop = 0;
      if (open && previous !== state) (state === 'success' ? done : feedback).focus({ preventScroll: true });
    }
    reposition();
  };
  const closed = () => {
    help.dismiss();
    saveDraft();
    open = false;
    trigger?.setAttribute('aria-expanded', 'false');
    if (state === 'success') showState('editing');
  };
  const close = (restoreFocus = false) => {
    if (!open) return;
    if (nativePopover) popover.hidePopover();
    else { popover.hidden = true; closed(); }
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  if (nativePopover) {
    popover.hidden = false;
    popover.addEventListener('beforetoggle', event => {
      if (event.newState === 'closed') closed();
    });
  } else popover.removeAttribute('popover');
  for (const button of triggers) {
    button.hidden = false;
    if (nativePopover) button.setAttribute('popovertarget', popover.id);
    button.addEventListener('click', event => {
      event.preventDefault();
      if (busy && button !== trigger) return;
      if (open && button === trigger) { close(true); return; }
      if (button !== trigger) {
        close();
        saveDraft();
        trigger = button;
        parent.value = button.dataset.replyId || '';
        replyContext.hidden = !parent.value;
        replyTarget.textContent = button.dataset.replyName || '';
        if (parent.value) replyTarget.href = `#comment-${parent.value}`;
        else replyTarget.removeAttribute('href');
        showState('editing');
      }
      if (!busy && state !== 'success') loadDraft();
      open = true;
      button.setAttribute('aria-expanded', 'true');
      if (nativePopover) popover.showPopover({ source: button });
      else popover.hidden = false;
      position();
      (state === 'success' ? done : busy ? feedback : form.elements.namedItem('message')).focus({ preventScroll: true });
    });
  }
  popover.querySelector('[data-close-comment]').addEventListener('click', () => close(true));
  done.addEventListener('click', () => close(true));
  document.addEventListener('keydown', event => {
    if (open && event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  if (!nativePopover) document.addEventListener('pointerdown', event => {
    if (open && !popover.contains(event.target) && !triggers.some(button => button.contains(event.target))) close();
  });
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);
  window.addEventListener('pagehide', saveDraft);
  window.addEventListener('pageshow', syncDraft);
  window.addEventListener('focus', syncDraft);
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === key()) syncDraft();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); else syncDraft(); });
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', event => { if (!popover.contains(event.target)) reposition(); }, true);
  window.visualViewport?.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('scroll', reposition);
  new ResizeObserver(reposition).observe(popover);
  return {
    get pending() { return pending; },
    set pending(value) {
      // Challenge renewal is asynchronous; another tab may have saved new
      // content meanwhile. Update this request without replacing that draft.
      const unchanged = JSON.stringify(readDraft()) === savedDraft;
      pending = value;
      if (unchanged) saveDraft();
      else savedDraft = JSON.stringify(currentDraft());
    },
    saveDraft,
    showState,
    clearDraft() {
      // A different tab may have edited this draft while the request was in
      // flight. Only remove the exact version that this tab submitted.
      if (JSON.stringify(readDraft()) === savedDraft) removeDraft();
      pending = undefined;
      const parentId = parent.value;
      form.reset();
      parent.value = parentId;
      savedDraft = JSON.stringify(currentDraft());
    },
    setBusy(value) {
      busy = value;
      if (!busy) syncDraft();
      for (const button of triggers) button.disabled = busy && button !== trigger;
      reposition();
    },
  };
}
