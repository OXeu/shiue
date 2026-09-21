import { createD2Viewport } from './d2-viewport.js';

const root = document.documentElement;
const states = [...document.querySelectorAll('[data-d2]')].map(element => ({
  element,
  output: element.querySelector('[data-d2-output]'),
  mode: '',
}));
const colorMode = () => root.dataset.colorMode === 'dark' ? 'dark' : 'light';

function update(state) {
  const mode = colorMode();
  if (state.mode === mode) return;
  const diagram = state.output.querySelector(`[data-d2-render-theme="${mode}"]`);
  if (!diagram) return;
  state.output.querySelector('[data-d2-active]')?.removeAttribute('data-d2-active');
  diagram.setAttribute('data-d2-active', '');
  state.viewer ||= createD2Viewport(state.element);
  state.viewer.update(diagram);
  state.mode = mode;
  state.element.dataset.d2Theme = mode;
}

if (states.length) {
  states.forEach(update);
  new MutationObserver(() => states.forEach(update))
    .observe(root, { attributes: true, attributeFilter: ['data-color-mode'] });
}
