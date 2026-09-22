import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadBuffer } from 'cheerio';
import sharp from 'sharp';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_HTML = 2 * 1024 * 1024;
const MAX_ICON = 5 * 1024 * 1024;
const USER_AGENT = 'Xeu-Friend-Importer/1.0';

export function websiteURL(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('网址必须使用 HTTP(S)，且不能包含用户名或密码');
  }
  url.hash = '';
  return url.href;
}

export function websiteKey(value) {
  const url = new URL(websiteURL(value));
  return `${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

// Limit decoded response bytes as well as Content-Length; a tiny compressed
// response can otherwise expand into a very large document or image.
async function download(url, limit, signal, accept) {
  const response = await fetch(websiteURL(url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    headers: { 'user-agent': USER_AGENT, accept },
    redirect: 'follow',
  });
  try {
    websiteURL(response.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > limit) throw new Error('响应文件过大');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('响应文件过大');
      chunks.push(chunk);
    }
    if (!size) throw new Error('响应为空');
    return { bytes: Buffer.concat(chunks), url: response.url, type: response.headers.get('content-type') || '' };
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function pageMetadata(bytes, url, type = '') {
  const charset = type.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  const $ = loadBuffer(bytes, { encoding: { defaultEncoding: 'utf-8', transportLayerEncodingLabel: charset } });
  const meta = name => clean($(`meta[name="${name}" i], meta[property="${name}" i]`).first().attr('content'));
  let base = url;
  try { base = websiteURL($('base[href]').first().attr('href') || url, url); } catch { /* Ignore unusable base. */ }
  const icons = [];
  $('link[href]').each((_, element) => {
    const link = $(element);
    const rel = (link.attr('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon') && !rel.includes('apple-touch-icon-precomposed')) return;
    try {
      const sizes = (link.attr('sizes') || '').toLowerCase();
      const width = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map(match => Number(match[1])));
      const score = sizes === 'any' || /svg/i.test(link.attr('type') || '') ? 256 : Math.min(width || (rel.includes('icon') ? 32 : 180), 256);
      icons.push({ url: websiteURL(link.attr('href'), base), score });
    } catch { /* Only download HTTP(S) icons, never data: or file: URLs. */ }
  });
  return {
    title: meta('og:site_name') || clean($('title').first().text()) || meta('og:title'),
    description: meta('description') || meta('og:description'),
    icons: icons.sort((a, b) => b.score - a.score).map(icon => icon.url),
  };
}

async function encodeIcon(bytes) {
  // Sharp does not decode ICO. Keep a structurally valid ICO as an image file;
  // all other supported formats (including SVG) become a small, inert WebP.
  if (bytes.length >= 6 && bytes.readUInt32LE(0) === 0x00010000) {
    const count = bytes.readUInt16LE(4);
    if (!count || count > 256 || bytes.length < 6 + count * 16) throw new Error('无效的 ICO 目录');
    for (let i = 0; i < count; i++) {
      const size = bytes.readUInt32LE(6 + i * 16 + 8);
      const offset = bytes.readUInt32LE(6 + i * 16 + 12);
      if (size < 40 || offset < 6 + count * 16 || offset + size > bytes.length) throw new Error('无效的 ICO 图片');
      const png = bytes.subarray(offset, offset + 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!png && ![40, 108, 124].includes(bytes.readUInt32LE(offset))) throw new Error('不支持的 ICO 编码');
    }
    return { bytes, extension: 'ico' };
  }
  const result = await sharp(bytes, { limitInputPixels: 16_777_216 })
    .rotate().resize(128, 128, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  return { bytes: result, extension: 'webp' };
}

async function loadFriends(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(value)) throw new Error('data/friends.json 必须是数组');
  return value;
}

/** Add only: existing entries are never silently replaced. Network failures
 * leave the directory unchanged, and a lock prevents concurrent lost updates. */
export async function addFriend(input, { root = repo, warn = console.warn } = {}) {
  const website = websiteURL(input.website);
  if (input.title !== undefined && !clean(input.title)) throw new Error('名称不能为空');
  if (input.icon !== undefined) websiteURL(input.icon, website);
  const dataDir = path.join(root, 'data');
  const dataFile = path.join(dataDir, 'friends.json');
  await mkdir(dataDir, { recursive: true });
  const lockFile = `${dataFile}.lock`;
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`另一个友链任务正在运行；若上次被强制中断，请确认没有运行中的任务后删除 ${lockFile}`);
    throw error;
  }
  const tempFile = `${dataFile}.${randomUUID()}.tmp`;
  let createdIcon;
  let committed = false;
  try {
    const friends = await loadFriends(dataFile);
    if (friends.some(friend => websiteKey(friend.website) === websiteKey(website))) throw new Error(`友链已存在：${website}`);
    const signal = AbortSignal.timeout(60_000);
    let metadata = { title: '', description: '', icons: [] };
    let finalURL = website;
    // Explicit fields also allow importing a temporarily unavailable site.
    if (input.title === undefined || input.description === undefined || input.icon === undefined) {
      try {
        const page = await download(website, MAX_HTML, signal, 'text/html,application/xhtml+xml');
        if (page.type && !/text\/html|application\/xhtml\+xml/i.test(page.type)) throw new Error('站点返回的不是 HTML');
        finalURL = page.url;
        metadata = pageMetadata(page.bytes, finalURL, page.type);
      } catch (error) {
        warn(`无法自动读取站点信息（${error.message}）；将使用手动信息或域名，并继续尝试图标。`);
      }
    }
    if (friends.some(friend => websiteKey(friend.website) === websiteKey(finalURL))) throw new Error(`跳转后的站点已存在：${finalURL}`);
    // An explicit --icon is authoritative: fail rather than silently replacing
    // a user-selected image with an unrelated fallback.
    const candidates = input.icon !== undefined ? [websiteURL(input.icon, finalURL)]
      : [...new Set([...metadata.icons.slice(0, 8), new URL('/favicon.ico', finalURL).href])];
    let icon;
    let iconSource;
    const failures = [];
    for (const candidate of candidates) {
      try {
        const response = await download(candidate, MAX_ICON, signal, 'image/*');
        icon = await encodeIcon(response.bytes);
        iconSource = response.url;
        break;
      } catch (error) {
        failures.push(`${candidate}: ${error.message}`);
        if (signal.aborted) break;
      }
    }
    if (!icon) throw new Error(`没有下载到有效图标，未添加友链。请使用 --icon 指定可访问的图标网址。\n${failures.join('\n')}`);
    const host = new URL(website).hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 100);
    const digest = createHash('sha256').update(icon.bytes).digest('hex').slice(0, 16);
    const image = `/friends/${host}-${digest}.${icon.extension}`;
    const entry = {
      title: clean(input.title ?? metadata.title) || new URL(website).hostname,
      description: clean(input.description ?? metadata.description),
      website,
      image,
      iconSource,
      health: input.health || '',
    };
    const iconFile = path.join(root, 'static', image);
    await mkdir(path.dirname(iconFile), { recursive: true });
    try {
      await writeFile(iconFile, icon.bytes, { flag: 'wx' });
      createdIcon = iconFile;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    friends.push(entry);
    await writeFile(tempFile, `${JSON.stringify(friends, null, 2)}\n`, { flag: 'wx' });
    await rename(tempFile, dataFile);
    committed = true;
    return entry;
  } finally {
    await rm(tempFile, { force: true });
    if (createdIcon && !committed) await rm(createdIcon, { force: true });
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

const usage = `用法：npm run friend:add -- <https://example.com> [选项]

自动读取标题、简介和 icon，将友链保存到 data/friends.json，图标下载到 static/friends/。
选项：
  --title <名称>          覆盖自动读取的站点名称
  --description <简介>    覆盖自动读取的简介（可传空字符串）
  --icon <图标网址>       下载指定图标，可使用站内相对路径
  --help                 显示帮助

示例：npm run friend:add -- https://example.com --title "朋友的博客" --description "记录生活" --icon /favicon.png
重复网址会报错，不会覆盖已有友链；站点无法访问时可同时提供三个选项。`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { title: { type: 'string' }, description: { type: 'string' }, icon: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) console.log(usage);
    else {
      if (positionals.length !== 1) throw new Error(usage);
      const entry = await addFriend({ website: positionals[0], ...values });
      console.log(`已添加：${entry.title}\n网址：${entry.website}\n图标：static${entry.image}\n数据：data/friends.json`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
