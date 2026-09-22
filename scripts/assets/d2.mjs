import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D2 } from '@d2lang/d2';
import { loadNotoSansSCBold, loadNotoSansSCRegular } from '@reogrid/font-sc';
import { optimize } from 'svgo';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipe = 'd2-ssg-v7-d2js-0.1.34-noto-sc-2.0.0';
const modes = {
  light: { themeID: 0 },
  dark: { themeID: 200 },
};

const exists = file => access(file).then(() => true, () => false);
const sourceKey = source => createHash('sha256').update(source).digest('hex');
const cacheKey = source => createHash('sha256').update(recipe).update('\0').update(source).digest('hex').slice(0, 24);

async function markdownFiles(directory) {
  if (!await exists(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(file));
    else if (entry.isFile() && /\.(?:md|markdown)$/i.test(entry.name)) files.push(file);
  }
  return files;
}

export function extractD2(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const diagrams = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!opening) continue;
    const marker = opening[1][0];
    const minimum = opening[1].length;
    const isD2 = /^d2(?:[ \t]+.*)?$/i.test(opening[2].trim());
    const body = [];
    let closed = false;
    for (index += 1; index < lines.length; index++) {
      if (new RegExp(`^ {0,3}${marker}{${minimum},}[ \\t]*$`).test(lines[index])) {
        closed = true;
        break;
      }
      if (isD2) body.push(lines[index]);
    }
    if (!closed && isD2) throw new Error('D2 代码块缺少结束围栏');
    if (!isD2) continue;
    const source = body.join('\n').trim();
    if (!source) throw new Error('D2 代码块不能为空');
    diagrams.push(source);
  }
  return diagrams;
}

function minifySVG(input, id, fingerprint, mode) {
  const removeExternalContent = {
    name: 'removeExternalContent',
    fn: () => ({
      element: {
        enter(node, parent) {
          if (!['script', 'foreignobject', 'img', 'image', 'iframe', 'object', 'embed', 'audio', 'video'].includes(node.name.toLowerCase())) return;
          const index = parent.children.indexOf(node);
          if (index >= 0) parent.children.splice(index, 1);
        },
      },
    }),
  };
  const result = optimize(input, {
    multipass: true,
    plugins: [
      removeExternalContent,
      { name: 'preset-default', params: { overrides: { cleanupIds: false } } },
      'removeScripts',
      { name: 'removeAttrs', params: { attrs: ['on.*'] } },
    ],
  });
  if (result.error) throw new Error(`SVG 压缩失败：${result.error}`);
  const prefix = `xeu-d2-${fingerprint}-${mode}`;
  let svg = result.data.replace(/^<\?xml[^>]*>\s*/i, '').replaceAll(/d2-\d+/g, prefix);
  // SVGO serializes quotes in style text as XML entities; CSS raw-text parsing
  // does not decode those entities, so restore them before inlining the SVG.
  svg = svg.replaceAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, opening, css, closing) => `${opening}${css.replaceAll('&quot;', '"')}${closing}`);
  svg = svg.replace('<svg ', `<svg id="${prefix}-root" data-d2-render-theme="${mode}" `);
  if (!/\saria-(?:label|labelledby)=/.test(svg.slice(0, svg.indexOf('>')))) {
    svg = svg.replace('<svg ', '<svg role="img" aria-label="D2 图表" ');
  }
  const urls = [...svg.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)].map(match => match[1]);
  const unsafeURL = urls.find(url => !url.startsWith('#') && !/^data:application\/font-woff;base64,[a-z0-9+/=]+$/i.test(url));
  if (/<(?:script|foreignObject|img|image|iframe|object|embed|audio|video)\b|<[^>]*\s(?:src|on[a-z]+)\s*=|<[^>]*(?:href|xlink:href)=["']\s*javascript:|@import\b|expression\s*\(/i.test(svg) || unsafeURL) {
    throw new Error(`D2 图表 ${id} 生成了不安全的 SVG`);
  }
  return svg;
}

function stripEmbeddedFonts(svg, fingerprint, mode) {
  const pattern = /@font-face\s*\{[^}]*\}/g;
  const faces = [...svg.matchAll(pattern)].map(match => match[0]);
  if (!faces.length) throw new Error(`D2 图表 ${fingerprint} 未生成内嵌字体`);
  const family = `xeu-d2-${fingerprint}-${mode}-font-`;
  return svg.replace(pattern, '')
    .replaceAll(`font-family:"${family}regular"`, 'font-family:var(--font-body)')
    .replaceAll(`font-family:"${family}bold"`, 'font-family:var(--font-body);font-weight:700')
    .replaceAll(`font-family:"${family}italic"`, 'font-family:var(--font-body);font-style:italic');
}

async function cachedSVG(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || !info.size) return undefined;
    const svg = await readFile(file, 'utf8');
    return svg.startsWith('<svg ') ? svg : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}

function compileError(error, item) {
  let detail = error.message;
  try {
    const diagnostics = JSON.parse(error.message);
    if (Array.isArray(diagnostics)) detail = diagnostics.map(diagnostic => diagnostic.errmsg || String(diagnostic)).join('; ');
  } catch {}
  return new Error(`D2 ${item.mode} 主题预渲染失败（${item.key.slice(0, 12)}）：${detail}`, { cause: error });
}

async function fontOptions() {
  const [regular, bold] = await Promise.all([loadNotoSansSCRegular(), loadNotoSansSCBold()]);
  // d2.js serializes compile options as JSON; Go's []byte decoder therefore
  // expects base64 even though the JavaScript declaration currently says Uint8Array.
  const fontRegular = Buffer.from(regular).toString('base64');
  const fontBold = Buffer.from(bold).toString('base64');
  return { fontRegular, fontBold };
}

export async function prepareD2(root = projectRoot, {
  contentDirectory = path.join(root, 'content'),
  log = console.log,
  signal,
} = {}) {
  const sources = new Map();
  for (const file of await markdownFiles(contentDirectory)) {
    for (const source of extractD2(await readFile(file, 'utf8'))) sources.set(sourceKey(source), source);
  }

  const cacheDirectory = path.join(root, '.cache/xeu-d2');
  const manifestFile = path.join(root, 'data/xeu/d2.json');
  await Promise.all([mkdir(cacheDirectory, { recursive: true }), mkdir(path.dirname(manifestFile), { recursive: true })]);
  const manifest = {};
  const missing = [];
  const retainedCacheFiles = new Set();
  for (const [key, source] of sources) {
    const fingerprint = cacheKey(source);
    const entry = {};
    for (const mode of Object.keys(modes)) {
      const file = path.join(cacheDirectory, `${fingerprint}-${mode}.svg`);
      retainedCacheFiles.add(path.basename(file));
      const svg = await cachedSVG(file);
      if (svg) entry[mode] = svg;
      else missing.push({ key, source, fingerprint, mode, file });
    }
    manifest[key] = entry;
  }

  let renderer;
  try {
    if (missing.length) {
      log(`预渲染 ${sources.size} 个 D2 图表（${missing.length} 个主题缓存未命中）`);
      const fonts = await fontOptions();
      renderer = new D2();
      const compiledDiagrams = new Map();
      for (const item of missing) {
        signal?.throwIfAborted();
        let rendered;
        try {
          let compiled = compiledDiagrams.get(item.key);
          if (!compiled) {
            compiled = await renderer.compile(item.source, {
              layout: 'dagre',
              themeID: modes.light.themeID,
              pad: 24,
              scale: 1,
              ...fonts,
            });
            compiledDiagrams.set(item.key, compiled);
          }
          rendered = await renderer.render(compiled.diagram, {
            ...compiled.renderOptions,
            themeID: modes[item.mode].themeID,
            noXMLTag: true,
            salt: `${item.fingerprint}-${item.mode}`,
          });
        } catch (error) {
          throw compileError(error, item);
        }
        const svg = stripEmbeddedFonts(
          minifySVG(rendered, item.key, item.fingerprint, item.mode),
          item.fingerprint,
          item.mode,
        );
        await atomicWrite(item.file, svg);
        manifest[item.key][item.mode] = svg;
      }
    }
  } finally {
    await renderer?.dispose();
  }

  await Promise.all((await readdir(cacheDirectory))
    .filter(file => file.endsWith('.svg') && !retainedCacheFiles.has(file))
    .map(file => unlink(path.join(cacheDirectory, file))));
  await atomicWrite(manifestFile, `${JSON.stringify(manifest)}\n`);
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  log(`D2 静态产物：${sources.size} 个图表 · ${(bytes / 1024).toFixed(1)} KiB（浅色 + 深色，已压缩）`);
  return manifest;
}

async function main() {
  const watching = process.argv.includes('--watch');
  await prepareD2();
  if (!watching) return;
  let pending;
  watch(path.join(projectRoot, 'content'), { recursive: true }, (_event, filename) => {
    if (!/\.(?:md|markdown)$/i.test(filename || '')) return;
    clearTimeout(pending);
    pending = setTimeout(() => prepareD2().catch(error => console.error(error)), 150);
  });
  console.log('正在监听 D2 内容变化…');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
