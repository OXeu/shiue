// 公式的静态预渲染。
//
// 从 Markdown 提取 $$...$$（展示）与 \(...\)（行内）源码，用 texsvg
// （MathJax + SVGO）渲染成自包含 SVG，写入 data/xeu/math.json 清单，
// 由 render-passthrough.html 内联。产物按「配方 + 源码」指纹缓存在
// .cache/xeu-math/，未变化的公式不重渲染。
//
// MathJax 的 id 形如 MJX-1-NCM-I-1D465，序号随渲染顺序变化，直接内联
// 会让同页多个公式的 id 互相覆盖。这里把所有 id / href 重写成
// 「公式指纹 + 元素序号」，使同一公式无论何时渲染都得到相同产物。

import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { texsvg } from 'texsvg';
import { optimize } from 'svgo';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 配方标识：渲染器版本、主题或处理方式变化时递增，使缓存整体失效。
const recipe = 'xeu-math-v1-texsvg-4.0.3';

const exists = file => access(file).then(() => true, () => false);
/** 清单键：由「类型 + 源码」决定，展示与行内公式的同名内容互不影响。 */
export const mathKey = ({ type, source }) => createHash('sha256').update(`${type}\n${source}`).digest('hex');
/** 缓存指纹：配方 + 清单键，前 24 位。 */
const cacheKey = key => createHash('sha256').update(recipe).update('\0').update(key).digest('hex').slice(0, 24);

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

/** 去掉 front matter 与代码块，只保留会被 goldmark 解析的正文。 */
function prose(markdown) {
  const text = markdown.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const body = text.replace(/^(---|\+\+\+)[ \t]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/, '');
  const lines = body.split('\n');
  const kept = [];
  let fence;
  for (const line of lines) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      // 结束围栏：与开启同字符且长度不小于开启。
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = undefined;
      kept.push('');
      continue;
    }
    if (opening) {
      fence = opening[1];
      kept.push('');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 按 goldmark 的 passthrough 规则提取公式。
 *
 * 与 CommonMark 一致的基本约束：展示公式的 $$ 独占一行；行内公式不跨行。
 * 这里比 Hugo 略微严格（两个公式之间不能只隔一个空行），未匹配时不渲染，
 * 只是回到普通文本，不会产生错误输出。
 */
export function extractMath(markdown) {
  const text = prose(markdown);
  const found = [];
  const blockPattern = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*$/gm;
  let rest = text.replace(blockPattern, (_match, source) => {
    found.push({ type: 'block', source: source.trim() });
    return '\n\n';
  });
  rest = rest.replace(/\\\(([^\n]*?)\\\)/g, (_match, source) => {
    found.push({ type: 'inline', source: source.trim() });
    return '\u0000';
  });
  return found;
}

/** 重写 id 与引用，避免同页多个公式的 id 冲突。 */
function namespaceSVG(svg, fingerprint) {
  const names = new Map();
  let counter = 0;
  return svg.replace(/\bid="([^"]+)"/g, (_match, id) => {
    if (!names.has(id)) names.set(id, `xeu-math-${fingerprint}-${counter++}`);
    return `id="${names.get(id)}"`;
  }).replace(/\bxlink:href="#([^"]+)"/g, (match, id) => {
    const target = names.get(id);
    return target ? `xlink:href="#${target}"` : match;
  });
}

/** 压缩并做安全过滤，输出可直接内联的 SVG。 */
function minifySVG(input, key, fingerprint) {
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
  const result = optimize(namespaceSVG(input, fingerprint), {
    multipass: true,
    plugins: [
      removeExternalContent,
      // cleanupIds 关闭：MathJax 的 <use> 依赖 id 引用。
      { name: 'preset-default', params: { overrides: { cleanupIds: false } } },
      'removeScripts',
      { name: 'removeAttrs', params: { attrs: ['on.*', 'data-latex', 'data-c', 'data-mml-node'] } },
    ],
  });
  if (result.error) throw new Error(`公式 SVG 压缩失败：${result.error}`);
  const svg = result.data.replace(/^<\?xml[^>]*>\s*/i, '');
  if (!svg.startsWith('<svg ')) throw new Error(`公式 ${key.slice(0, 12)} 未能生成 SVG`);
  if (/<(?:script|foreignObject|img|image|iframe|object|embed|audio|video)\b|<[^>]*\s(?:src|on[a-z]+)\s*=|javascript:/i.test(svg)) {
    throw new Error(`公式 ${key.slice(0, 12)} 生成了不安全的 SVG`);
  }
  return svg;
}

/** 读取缓存 SVG；损坏或非 SVG 内容视为未命中。 */
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

/**
 * 预渲染全部公式并更新清单。
 * 返回「清单键 → SVG」映射，模板按同样的键查找。
 */
export async function prepareMath(root = projectRoot, {
  contentDirectory = path.join(root, 'content'),
  log = console.log,
  signal,
} = {}) {
  const sources = new Map();
  for (const file of await markdownFiles(contentDirectory)) {
    signal?.throwIfAborted();
    for (const item of extractMath(await readFile(file, 'utf8'))) {
      sources.set(mathKey(item), item);
    }
  }

  const cacheDirectory = path.join(root, '.cache/xeu-math');
  const manifestFile = path.join(root, 'data/xeu/math.json');
  await Promise.all([mkdir(cacheDirectory, { recursive: true }), mkdir(path.dirname(manifestFile), { recursive: true })]);

  const previous = JSON.parse(await readFile(manifestFile, 'utf8').catch(() => '{}'));
  const manifest = {};
  const missing = [];
  const retained = new Set();
  for (const [key, item] of sources) {
    const fingerprint = cacheKey(key);
    const file = path.join(cacheDirectory, `${fingerprint}.svg`);
    retained.add(path.basename(file));
    const svg = await cachedSVG(file) ?? (typeof previous[key] === 'string' && previous[key].startsWith('<svg ') ? previous[key] : undefined);
    if (svg) {
      manifest[key] = svg;
      if (!await cachedSVG(file)) await atomicWrite(file, svg);
    } else {
      missing.push({ key, item, fingerprint, file });
    }
  }

  for (const { key, item, fingerprint, file } of missing) {
    signal?.throwIfAborted();
    let raw;
    try {
      raw = await texsvg(item.source, { optimize: false });
    } catch (error) {
      throw new Error(`公式渲染失败（${key.slice(0, 12)}）：${error.message}`, { cause: error });
    }
    // MathJax 遇到语法错误不抛异常，而是输出带 data-mjx-error 的占位 SVG。
    const failure = raw.match(/data-mjx-error="([^"]*)"/);
    if (failure) throw new Error(`公式渲染失败（${key.slice(0, 12)}）：${failure[1]}\n${item.source}`);
    const svg = minifySVG(raw, key, fingerprint);
    await atomicWrite(file, svg);
    manifest[key] = svg;
  }

  await Promise.all((await readdir(cacheDirectory))
    .filter(file => file.endsWith('.svg') && !retained.has(file))
    .map(file => unlink(path.join(cacheDirectory, file))));
  // 只在内容变化时写入，避免开发服务器因 mtime 变化重复重建。
  const output = `${JSON.stringify(manifest)}\n`;
  if (await readFile(manifestFile, 'utf8').catch(() => undefined) !== output) await atomicWrite(manifestFile, output);
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  log(`公式静态产物：${sources.size} 个公式 · 缓存复用 ${sources.size - missing.length} 个 · 新生成 ${missing.length} 个 · ${(bytes / 1024).toFixed(1)} KiB`);
  return manifest;
}

async function main() {
  await prepareMath();
  if (!process.argv.includes('--watch')) return;
  let pending;
  let running = Promise.resolve();
  const watcher = watch(path.join(projectRoot, 'content'), { recursive: true }, (_event, filename) => {
    if (!/\.(?:md|markdown)$/i.test(filename || '')) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      running = running.then(() => prepareMath()).catch(error => console.error(error.message));
    }, 150);
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => {
    clearTimeout(pending);
    watcher.close();
  });
  console.log('正在监听公式变化…');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
