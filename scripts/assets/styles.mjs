// Optimize the rendered site, so Markdown, shortcodes and runtime-created DOM
// all participate in pruning. Pages sharing scripts share one stylesheet.
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { PurgeCSS } from 'purgecss';
import { transform } from 'lightningcss';

const digest = value => createHash('sha256').update(value).digest();
const variables = value => value.match(/--[\w-]+/g) || [];
const dynamicAttributes = [
  'aria-current', 'aria-expanded', 'aria-pressed', 'role', 'data-color-mode',
  'data-article-transition', 'data-article-transition-cover', 'data-state',
];

export async function optimizeCSS(css, content, runtimeVariables = []) {
  const [{ css: pruned }] = await new PurgeCSS().purge({
    css: [{ raw: css }], content,
    keyframes: true, variables: true, dynamicAttributes,
    safelist: {
      // These pseudo-elements represent browser snapshots, not HTML nodes.
      greedy: [/::view-transition-/],
      variables: runtimeVariables,
    },
  });
  return transform({ filename: 'xeu.css', code: Buffer.from(pruned), minify: true }).code;
}

function assetPath(url) {
  if (!url) return null;
  // Match fingerprinted local assets even when Hugo uses a baseURL subpath.
  const pathname = new URL(url, 'https://assets.invalid').pathname;
  const match = pathname.match(/\/(css|js)\/([\w.-]+\.[a-f0-9]{64}\.(?:css|js))$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function replaceAttribute(tag, name, value) {
  const pattern = new RegExp(`(\\b${name}=)(?:"[^"]*"|'[^']*'|[^\\s>]+)`);
  return tag.replace(pattern, (_, prefix) => `${prefix}"${value}"`);
}

export async function optimizeStyles(destination, { log = () => {}, signal } = {}) {
  const pages = [];
  const groups = new Map();
  const files = new Map();
  const readAsset = async file => {
    if (!files.has(file)) files.set(file, await readFile(path.join(destination, file), 'utf8'));
    return files.get(file);
  };
  for (const file of (await readdir(destination, { recursive: true })).sort()) {
    if (!file.endsWith('.html')) continue;
    signal?.throwIfAborted();
    const html = await readFile(path.join(destination, file), 'utf8');
    const $ = load(html);
    const links = $('link[rel="stylesheet"]').toArray()
      .map(element => $(element).attr('href')).filter(url => assetPath(url));
    if (!links.length) continue; // Redirect aliases have no theme assets.
    const scripts = new Set();
    $('script[src], template[data-lazy-feature]').each((_, element) => {
      const file = assetPath($(element).attr('src') || $(element).attr('data-script'));
      if (file) scripts.add(file);
    });
    const deferred = $('template[data-lazy-feature]').toArray()
      .map(element => {
        const url = $(element).attr('data-stylesheet');
        if (!assetPath(url)) throw new Error(`延迟样式地址无效：${file} (${url})`);
        return url;
      });
    const page = { file, html, replacements: new Map() };
    pages.push(page);
    // Group by features rather than individual pages to retain browser caching.
    const features = [...scripts].sort().join('|');
    for (const url of [...links, ...deferred]) {
      const source = assetPath(url);
      const key = `${source}|${links.includes(url) ? features : 'deferred'}`;
      if (!groups.has(key)) groups.set(key, { source, pages: [], scripts: new Set(), deferred: new Set() });
      const group = groups.get(key);
      group.pages.push({ page, url });
      scripts.forEach(script => group.scripts.add(script));
      deferred.forEach(style => group.deferred.add(assetPath(style)));
    }
  }

  const generated = new Set();
  let before = 0;
  let after = 0;
  for (const group of groups.values()) {
    signal?.throwIfAborted();
    const source = await readAsset(group.source);
    const content = group.pages.map(({ page }) => ({ raw: page.html, extension: 'html' }));
    const runtimeVariables = new Set();
    for (const script of group.scripts) {
      const raw = await readAsset(script);
      content.push({ raw, extension: 'js' });
      variables(raw).forEach(variable => runtimeVariables.add(variable));
    }
    // Deferred CSS still needs tokens from the initial stylesheet. Inline
    // Shiki colors and JS getPropertyValue() calls also need their definitions.
    for (const style of group.deferred) {
      variables(await readAsset(style)).forEach(variable => runtimeVariables.add(variable));
    }
    for (const { page } of group.pages) variables(page.html).forEach(variable => runtimeVariables.add(variable));
    const code = await optimizeCSS(source, content, [...runtimeVariables]);
    const hash = digest(code);
    const name = `${path.basename(group.source).split('.')[0]}.${hash.toString('hex')}.css`;
    const output = `css/${name}`;
    await writeFile(path.join(destination, output), code);
    generated.add(output);
    const integrity = `sha256-${hash.toString('base64')}`;
    for (const { page, url } of group.pages) {
      page.replacements.set(url, { url: url.replace(/[^/]+$/, name), integrity });
      before += Buffer.byteLength(source);
      after += code.length;
    }
  }

  for (const page of pages) {
    const html = page.html.replace(/<(?:link|template)\b[^>]*>/g, tag => {
      const $ = load(tag, null, false);
      const element = $('link, template').first();
      const lazy = element.is('template');
      const replacement = page.replacements.get(element.attr(lazy ? 'data-stylesheet' : 'href'));
      if (!replacement) return tag;
      tag = replaceAttribute(tag, lazy ? 'data-stylesheet' : 'href', replacement.url);
      return replaceAttribute(tag, lazy ? 'data-stylesheet-integrity' : 'integrity', replacement.integrity);
    });
    if (html !== page.html) await writeFile(path.join(destination, page.file), html);
  }
  // Only retire input files after every page points at its optimized asset.
  for (const source of new Set([...groups.values()].map(group => group.source))) {
    if (!generated.has(source)) await rm(path.join(destination, source));
  }
  const saved = before ? Math.round((1 - after / before) * 100) : 0;
  log(`${pages.length} 个页面 · ${generated.size} 份共享 CSS · 页面引用的 CSS 总量减少 ${saved}%`);
  return { pages: pages.length, stylesheets: generated.size, before, after, saved };
}
