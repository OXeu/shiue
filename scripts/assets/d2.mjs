// D2 图表的静态预渲染。
//
// 从 Markdown 提取 ```d2 代码块，用 d2.js 编译渲染为 SVG（浅色 + 深色
// 两套主题），经 SVGO 压缩与安全过滤后写入 data/xeu/d2.json 清单，
// 由 Hugo 模板内联到页面。渲染结果按「配方 + 源码」指纹缓存在
// .cache/xeu-d2/，未变化的图表不重渲染。

import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D2 } from '@d2lang/d2';
import { loadNotoSansSCBold, loadNotoSansSCRegular } from '@reogrid/font-sc';
import { optimize } from 'svgo';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 配方标识：D2 版本或字体变化时递增，使缓存整体失效。
const recipe = 'd2-ssg-v7-d2js-0.1.34-noto-sc-2.0.0';
const modes = {
  light: { themeID: 0 },
  dark: { themeID: 200 },
};

const exists = file => access(file).then(() => true, () => false);
/** 源码指纹：清单键（完整 64 位），同一图表多处引用共用一份。 */
const sourceKey = source => createHash('sha256').update(source).digest('hex');
/** 缓存指纹：配方 + 源码，前 24 位。 */
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

/** 从 Markdown 提取全部 D2 代码块源码；支持围栏缩进与波浪线围栏。 */
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
      // 结束围栏：与开启同字符、长度不小于开启、无尾随内容。
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

/** 压缩 SVG 并做安全过滤。 */
function minifySVG(input, id, fingerprint, mode) {
  // 自定义插件：剥离所有能加载外部内容或执行脚本的元素。
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
      // cleanupIds 关闭：D2 的 id 被后续字体替换与主题选择器引用。
      { name: 'preset-default', params: { overrides: { cleanupIds: false } } },
      'removeScripts',
      { name: 'removeAttrs', params: { attrs: ['on.*'] } },
    ],
  });
  if (result.error) throw new Error(`SVG 压缩失败：${result.error}`);

  const prefix = `xeu-d2-${fingerprint}-${mode}`;
  let svg = result.data.replace(/^<\?xml[^>]*>\s*/i, '').replaceAll(/d2-\d+/g, prefix);
  // SVGO 会把 <style> 内的引号转义为 XML 实体；CSS 原文解析不解码实体，
  // 内联前必须还原，否则字体规则失效。
  svg = svg.replaceAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, opening, css, closing) => `${opening}${css.replaceAll('&quot;', '"')}${closing}`);
  svg = svg.replace('<svg ', `<svg id="${prefix}-root" data-d2-render-theme="${mode}" `);
  // 无障碍标签缺失时补一个兜底。
  if (!/\saria-(?:label|labelledby)=/.test(svg.slice(0, svg.indexOf('>')))) {
    svg = svg.replace('<svg ', '<svg role="img" aria-label="D2 图表" ');
  }

  // 输出前安全复查：只允许锚点引用与内嵌 WOFF 字体 data: URL。
  const urls = [...svg.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)].map(match => match[1]);
  const unsafeURL = urls.find(url => !url.startsWith('#') && !/^data:application\/font-woff;base64,[a-z0-9+/=]+$/i.test(url));
  if (/<(?:script|foreignObject|img|image|iframe|object|embed|audio|video)\b|<[^>]*\s(?:src|on[a-z]+)\s*=|<[^>]*(?:href|xlink:href)=["']\s*javascript:|@import\b|expression\s*\(/i.test(svg) || unsafeURL) {
    throw new Error(`D2 图表 ${id} 生成了不安全的 SVG`);
  }
  return svg;
}

/** 剥离 D2 内嵌的 Noto Sans SC @font-face（约数 MB），改用站点 CSS 变量。 */
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

/** 读取缓存 SVG；损坏或非 SVG 内容（错误消息等）视为未命中。 */
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

/** 把 d2.js 的编译错误翻译成带图表指纹的中文信息。 */
function compileError(error, item) {
  let detail = error.message;
  try {
    const diagnostics = JSON.parse(error.message);
    if (Array.isArray(diagnostics)) detail = diagnostics.map(diagnostic => diagnostic.errmsg || String(diagnostic)).join('; ');
  } catch { /* 非结构化错误消息：原样保留。 */ }
  return new Error(`D2 ${item.mode} 主题预渲染失败（${item.key.slice(0, 12)}）：${detail}`, { cause: error });
}

async function fontOptions() {
  const [regular, bold] = await Promise.all([loadNotoSansSCRegular(), loadNotoSansSCBold()]);
  // d2.js 以 JSON 序列化编译选项；Go 的 []byte 解码因此要求 base64，
  // 尽管 JavaScript 声明写的是 Uint8Array。
  return {
    fontRegular: Buffer.from(regular).toString('base64'),
    fontBold: Buffer.from(bold).toString('base64'),
  };
}

/**
 * 预渲染全部 D2 图表并更新清单。
 * 缓存命中的主题跳过；只有 miss 的条目才初始化 d2.js 渲染器。
 */
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
      // 同一图表浅深两主题只编译一次，渲染两次。
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

  // 清理不再被引用的缓存文件。
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
  // 防抖：150ms 内的连续文件变更只触发一次重渲染。
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
