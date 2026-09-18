import { engineURL } from '@params';
import { createMermaidViewport } from './mermaid-viewport.js';

const root = document.documentElement;
const states = [...document.querySelectorAll('[data-mermaid]')].map(element => ({
  element,
  output: element.querySelector('[data-mermaid-output]'),
  details: element.querySelector('.mermaid-source'),
  status: element.querySelector('[data-mermaid-status]'),
  source: element.querySelector('code').textContent,
  active: false,
  failed: false,
  mode: '',
}));
const colorMode = () => root.dataset.colorMode === 'dark' ? 'dark' : 'light';
let enginePromise;
let running = false;
let pending = false;
let sequence = 0;

function configuration(mode) {
  const style = getComputedStyle(root);
  const token = name => style.getPropertyValue(name).trim();
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
      darkMode: mode === 'dark',
      fontFamily: token('--font-body'),
      fontSize: '16px',
      background: token('--surface'),
      primaryColor: token('--surface-muted'),
      primaryTextColor: token('--text'),
      primaryBorderColor: token('--control-border'),
      secondaryColor: token('--surface-muted'),
      secondaryTextColor: token('--text'),
      tertiaryColor: token('--surface'),
      tertiaryTextColor: token('--text'),
      lineColor: token('--text-soft'),
      textColor: token('--text'),
      clusterBkg: token('--surface-muted'),
      clusterBorder: token('--border-hover'),
      edgeLabelBackground: token('--surface'),
      noteBkgColor: token('--surface-muted'),
      noteTextColor: token('--text'),
      noteBorderColor: token('--control-border'),
    },
  };
}

function fail(state) {
  state.failed = true;
  state.output.hidden = true;
  state.element.querySelector('[data-mermaid-controls]').hidden = true;
  state.element.querySelector('[data-mermaid-hint]').hidden = true;
  state.details.open = true;
  state.status.hidden = false;
}

async function draw() {
  pending = true;
  if (running) return;
  running = true;
  try {
    // Mermaid 的配置是全局的；串行处理，避免多个图表或主题切换互相覆盖。
    while (pending) {
      pending = false;
      const mode = colorMode();
      const active = states.filter(state => state.active && !state.failed && state.mode !== mode);
      if (!active.length) continue;
      let mermaid;
      try {
        enginePromise ||= import(engineURL).then(module => module.default);
        [mermaid] = await Promise.all([enginePromise, document.fonts.ready]);
      } catch {
        active.forEach(fail);
        continue;
      }
      if (colorMode() !== mode) { pending = true; continue; }
      mermaid.initialize(configuration(mode));
      for (const state of active) {
        if (colorMode() !== mode) { pending = true; break; }
        const id = `xeu-mermaid-${++sequence}`;
        state.output.setAttribute('aria-busy', 'true');
        try {
          const { svg, bindFunctions } = await mermaid.render(id, state.source);
          if (colorMode() !== mode) { pending = true; break; }
          state.output.innerHTML = svg;
          const diagram = state.output.querySelector('svg');
          if (!diagram.hasAttribute('aria-labelledby')) diagram.setAttribute('aria-label', 'Mermaid 图表');
          bindFunctions?.(state.output);
          state.output.hidden = false;
          state.viewer ||= createMermaidViewport(state.element);
          state.viewer.update(diagram);
          if (!state.mode) state.details.open = false;
          state.mode = mode;
          state.element.dataset.mermaidTheme = mode;
        } catch {
          fail(state);
        } finally {
          document.getElementById(`d${id}`)?.remove();
          state.output.removeAttribute('aria-busy');
        }
      }
    }
  } finally {
    running = false;
  }
}

if (states.length) {
  new MutationObserver(draw).observe(root, { attributes: true, attributeFilter: ['data-color-mode'] });
  if ('IntersectionObserver' in window) {
    const byElement = new Map(states.map(state => [state.element, state]));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        byElement.get(entry.target).active = true;
        observer.unobserve(entry.target);
      }
      draw();
    }, { rootMargin: '300px' });
    states.forEach(state => observer.observe(state.element));
  } else {
    states.forEach(state => { state.active = true; });
    draw();
  }
}
