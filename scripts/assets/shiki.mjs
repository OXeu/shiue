// 在构建期生成浅色 / 深色 Shiki HTML，由 Hugo 的代码块渲染钩子内联。
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { bundledLanguages, createHighlighter } from 'shiki';
import { writeJSON } from '../deploy/files.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const markdown = new MarkdownIt('commonmark');
const themes = { light: 'github-light', dark: 'github-dark' };
const aliases = { clike: 'c', shell: 'shellscript', plaintext: 'text' };
const sourceKey = (language, source) => createHash('sha256').update(`${language}\n${source}`).digest('hex');

/** 使用 CommonMark 解析器处理嵌套列表、引用、缩进及不同长度的围栏。 */
export function extractCodeBlocks(input) {
  const body = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/^(---|\+\+\+)[ \t]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/, '');
  const blocks = [];
  const containers = [];
  for (const token of markdown.parse(body, {})) {
    if (token.nesting === 1) containers.push(token.type);
    else if (token.nesting === -1) containers.pop();
    if (token.type !== 'fence') continue;
    // 对齐 Goldmark 的 .Inner：去掉最后一个换行；列表内的空白行不保留缩进。
    let source = token.content.replace(/\n$/, '');
    if (containers.lastIndexOf('list_item_open') > containers.lastIndexOf('blockquote_open')) {
      source = source.replace(/^[ \t]+$/gm, '');
    }
    blocks.push({ language: token.info.trim().split(/\s+/)[0].toLowerCase(), source });
  }
  return blocks;
}

export function resolveLanguage(language) {
  const normalized = language.toLowerCase();
  const lang = aliases[normalized] || normalized;
  return ['text', 'txt', 'plain', 'ansi'].includes(lang) || Object.hasOwn(bundledLanguages, lang) ? lang : 'text';
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(file));
    else if (entry.isFile() && /\.(?:md|markdown)$/i.test(entry.name)) files.push(file);
  }
  return files.sort();
}

async function readCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeIfChanged(file, value) {
  const previous = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (previous !== `${JSON.stringify(value, null, 2)}\n`) await writeJSON(file, value);
}

export async function prepareShiki(root = projectRoot, { log = console.log, signal } = {}) {
  const blocks = new Map();
  for (const file of await markdownFiles(path.join(root, 'content'))) {
    signal?.throwIfAborted();
    for (const block of extractCodeBlocks(await readFile(file, 'utf8'))) {
      blocks.set(sourceKey(block.language, block.source), block);
    }
  }

  const dependencies = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).dependencies;
  const recipe = JSON.stringify({ version: 1, shiki: dependencies.shiki, markdown: dependencies['markdown-it'], themes, aliases });
  const cacheFile = path.join(root, '.cache/xeu-shiki/code.json');
  const cache = await readCache(cacheFile);
  const cached = cache?.recipe === recipe ? cache.blocks : {};
  const manifest = {};
  const missing = [];
  for (const [key, block] of blocks) {
    const html = cached?.[key];
    if (typeof html === 'string' && html.startsWith('<pre class="shiki ') && html.endsWith('</pre>')) manifest[key] = html;
    else missing.push({ key, ...block });
  }

  if (missing.length) {
    const langs = [...new Set(missing.map(block => resolveLanguage(block.language)))]
      .filter(lang => Object.hasOwn(bundledLanguages, lang));
    const highlighter = await createHighlighter({ themes: Object.values(themes), langs });
    try {
      for (const block of missing) {
        signal?.throwIfAborted();
        const lang = resolveLanguage(block.language);
        manifest[block.key] = highlighter.codeToHtml(block.source, {
          lang,
          themes,
          transformers: [{ code(node) { node.properties.class = `language-${lang}`; } }],
        });
      }
    } finally {
      highlighter.dispose();
    }
  }

  // 稳定排序且只写入变化的文件，避免开发服务器重复触发重建。
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right)));
  await writeIfChanged(cacheFile, { recipe, blocks: sorted });
  await writeIfChanged(path.join(root, 'data/xeu/shiki.json'), sorted);
  log(`Shiki 静态高亮：${blocks.size} 个代码块 · 缓存复用 ${blocks.size - missing.length} 个 · 新生成 ${missing.length} 个`);
  return sorted;
}

async function main() {
  await prepareShiki();
  if (!process.argv.includes('--watch')) return;
  let pending;
  let running = Promise.resolve();
  const watcher = watch(path.join(projectRoot, 'content'), { recursive: true }, (_event, filename) => {
    if (!/\.(?:md|markdown)$/i.test(filename || '')) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      running = running.then(() => prepareShiki()).catch(error => console.error(error.message));
    }, 150);
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => {
    clearTimeout(pending);
    watcher.close();
  });
  console.log('正在监听代码块变化…');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
