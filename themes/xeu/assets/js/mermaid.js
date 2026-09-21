import { createMermaidViewport } from './mermaid-viewport.js';

const root = document.documentElement;
const states = [...document.querySelectorAll('[data-mermaid]')].map(element => ({
  element,
  output: element.querySelector('[data-mermaid-output]'),
  details: element.querySelector('.mermaid-source'),
  mode: '',
}));
const colorMode = () => root.dataset.colorMode === 'dark' ? 'dark' : 'light';

function update(state) {
  const mode = colorMode();
  if (state.mode === mode) return;
  const diagram = state.output.querySelector(`[data-mermaid-render-theme="${mode}"]`);
  if (!diagram) return;
  state.output.querySelector('[data-mermaid-active]')?.removeAttribute('data-mermaid-active');
  diagram.setAttribute('data-mermaid-active', '');
  state.viewer ||= createMermaidViewport(state.element);
  state.viewer.update(diagram);
  state.mode = mode;
  state.element.dataset.mermaidTheme = mode;
}

if (states.length) {
  states.forEach(update);
  new MutationObserver(() => states.forEach(update))
    .observe(root, { attributes: true, attributeFilter: ['data-color-mode'] });
}
