import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMermaid } from '@mermaid-js/mermaid-cli';
import puppeteer from 'puppeteer';
import { optimize } from 'svgo';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipe = 'mermaid-ssg-v1';
const modes = {
  light: {
    background: '#fff', primary: '#f7f7f8', text: '#202024', softText: '#505057',
    border: '#85858e', clusterBorder: '#c9c9d0', line: '#505057',
  },
  dark: {
    background: '#18181b', primary: '#242428', text: '#fafafa', softText: '#d4d4d8',
    border: '#83838e', clusterBorder: '#565660', line: '#d4d4d8',
  },
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

export function extractMermaid(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const diagrams = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+.*)?$/i);
    if (!opening) continue;
    const marker = opening[1][0];
    const minimum = opening[1].length;
    const body = [];
    let closed = false;
    for (index += 1; index < lines.length; index++) {
      if (new RegExp(`^ {0,3}${marker}{${minimum},}[ \\t]*$`).test(lines[index])) {
        closed = true;
        break;
      }
      body.push(lines[index]);
    }
    if (!closed) throw new Error('Mermaid 代码块缺少结束围栏');
    const source = body.join('\n').trim();
    if (!source) throw new Error('Mermaid 代码块不能为空');
    diagrams.push(source);
  }
  return diagrams;
}

function mermaidConfig(mode) {
  const color = modes[mode];
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: 'Arial, sans-serif',
    themeVariables: {
      darkMode: mode === 'dark',
      fontFamily: 'Arial, sans-serif',
      fontSize: '16px',
      background: color.background,
      primaryColor: color.primary,
      primaryTextColor: color.text,
      primaryBorderColor: color.border,
      secondaryColor: color.primary,
      secondaryTextColor: color.text,
      tertiaryColor: color.background,
      tertiaryTextColor: color.text,
      lineColor: color.line,
      textColor: color.text,
      clusterBkg: color.primary,
      clusterBorder: color.clusterBorder,
      edgeLabelBackground: color.background,
      noteBkgColor: color.primary,
      noteTextColor: color.text,
      noteBorderColor: color.border,
    },
  };
}

function minifySVG(input, id, mode) {
  const result = optimize(input, {
    multipass: true,
    plugins: [
      { name: 'preset-default', params: { overrides: { cleanupIds: false } } },
      'removeScripts',
      { name: 'removeAttrs', params: { attrs: ['on.*'] } },
    ],
  });
  if (result.error) throw new Error(`SVG 压缩失败：${result.error}`);
  let svg = result.data.replace(/^<\?xml[^>]*>\s*/i, '');
  svg = svg.replace('<svg ', `<svg data-mermaid-render-theme="${mode}" `);
  if (!/\saria-(?:label|labelledby)=/.test(svg.slice(0, svg.indexOf('>')))) {
    svg = svg.replace('<svg ', '<svg aria-label="Mermaid 图表" ');
  }
  if (/<script\b|\son[a-z]+\s*=|(?:href|xlink:href)=["']\s*javascript:/i.test(svg)) {
    throw new Error(`Mermaid 图表 ${id} 生成了不安全的 SVG`);
  }
  return svg;
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

export async function prepareMermaid(root = projectRoot, {
  contentDirectory = path.join(root, 'content'),
  log = console.log,
  signal,
} = {}) {
  const sources = new Map();
  for (const file of await markdownFiles(contentDirectory)) {
    for (const source of extractMermaid(await readFile(file, 'utf8'))) sources.set(sourceKey(source), source);
  }

  const cacheDirectory = path.join(root, '.cache/xeu-mermaid');
  const manifestFile = path.join(root, 'data/xeu/mermaid.json');
  await Promise.all([mkdir(cacheDirectory, { recursive: true }), mkdir(path.dirname(manifestFile), { recursive: true })]);
  const manifest = {};
  const missing = [];
  for (const [key, source] of sources) {
    const fingerprint = cacheKey(source);
    const entry = {};
    for (const mode of Object.keys(modes)) {
      const file = path.join(cacheDirectory, `${fingerprint}-${mode}.svg`);
      const svg = await cachedSVG(file);
      if (svg) entry[mode] = svg;
      else missing.push({ key, source, fingerprint, mode, file });
    }
    manifest[key] = entry;
  }

  let browser;
  try {
    if (missing.length) {
      log(`预渲染 ${sources.size} 个 Mermaid 图表（${missing.length} 个主题缓存未命中）`);
      browser = await puppeteer.launch({
        headless: 'shell',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      for (const item of missing) {
        signal?.throwIfAborted();
        let rendered;
        try {
          rendered = await renderMermaid(browser, item.source, 'svg', {
            viewport: { width: 1600, height: 1200, deviceScaleFactor: 1 },
            backgroundColor: 'transparent',
            mermaidConfig: mermaidConfig(item.mode),
            svgId: `xeu-mermaid-${item.fingerprint}-${item.mode}`,
          });
        } catch (error) {
          throw new Error(`Mermaid ${item.mode} 主题预渲染失败（${item.key.slice(0, 12)}）：${error.message}`, { cause: error });
        }
        const svg = minifySVG(new TextDecoder().decode(rendered.data), item.key, item.mode);
        await atomicWrite(item.file, svg);
        manifest[item.key][item.mode] = svg;
      }
    }
  } finally {
    await browser?.close();
  }

  await atomicWrite(manifestFile, `${JSON.stringify(manifest)}\n`);
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  log(`Mermaid 静态产物：${sources.size} 个图表 · ${(bytes / 1024).toFixed(1)} KiB（浅色 + 深色，已压缩）`);
  return manifest;
}

async function main() {
  const watching = process.argv.includes('--watch');
  await prepareMermaid();
  if (!watching) return;
  let pending;
  watch(path.join(projectRoot, 'content'), { recursive: true }, (_event, filename) => {
    if (!/\.(?:md|markdown)$/i.test(filename || '')) return;
    clearTimeout(pending);
    pending = setTimeout(() => prepareMermaid().catch(error => console.error(error)), 150);
  });
  console.log('正在监听 Mermaid 内容变化…');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
