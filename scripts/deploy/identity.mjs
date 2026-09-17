import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { writeJSON } from './files.mjs';

export const AVATAR_SOURCE = 'https://avatars.githubusercontent.com/u/36541432';
export const AVATAR_SIZES = [48, 80, 96, 160, 192, 240, 320, 512];
export const ICON_SIZES = [16, 32, 48, 180, 192, 512];
// Invalidate assets generated before GitHub's HTTP 200 placeholder was rejected.
const recipe = JSON.stringify({ version: 2, avatars: AVATAR_SIZES, icons: ICON_SIZES, webpQuality: 85 });
// GitHub can serve this image with HTTP 200 from a user's avatar URL:
// https://github.githubassets.com/images/gravatars/gravatar-user-420.png
const githubPlaceholderHash = '2ae73e12cb1e9989929920c4e9da0b02b6f6f8f0bd1944ac9ebfbf6b4dca746b';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestFile = root => path.join(root, 'data/xeu/identity.json');

// Modern ICO containers support embedded PNG frames without another encoder.
export function makeICO(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.bytes)]);
}

async function fetchAvatar({ signal, fetchImpl, timeoutMs, log }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const url = new URL(AVATAR_SOURCE);
    url.searchParams.set('v', '4');
    // Retry the canonical avatar URL without a size transformation. Keep to
    // GitHub's own parameters; every invocation still makes a no-store request.
    if (attempt === 0) url.searchParams.set('s', '512');
    try {
      const response = await fetchImpl(url.href, {
        cache: 'no-store', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: 'image/*', 'cache-control': 'no-cache', pragma: 'no-cache', 'user-agent': 'Xeu-Site-Identity/1.0' },
      });
      try {
        if (!response.ok) throw new Error(`GitHub 头像返回 HTTP ${response.status}`);
        if (!/^image\//i.test(response.headers.get('content-type') || '')) throw new Error('GitHub 头像响应不是图片');
        const limit = 5 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) throw new Error('GitHub 头像文件超过 5MB');
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > limit) throw new Error('GitHub 头像文件超过 5MB');
          chunks.push(chunk);
        }
        if (!size) throw new Error('GitHub 头像为空');
        const bytes = Buffer.concat(chunks);
        if (createHash('sha256').update(bytes).digest('hex') === githubPlaceholderHash) {
          throw new Error('GitHub 返回默认占位图，未获取到用户头像');
        }
        return bytes;
      } finally {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 1) throw new Error(`无法获取最新 GitHub 头像，不使用旧缓存继续部署：${error.message}`, { cause: error });
      log(`头像获取失败，重试一次：${error.message}`);
      await delay(300, undefined, { signal });
    }
  }
}

async function writeAsset(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function identityAssets(manifest) {
  return [...manifest.favicons, manifest.appleTouchIcon, manifest.touchIcon, manifest.socialImage, manifest.ico, ...manifest.avatars];
}

export async function readIdentity(root = projectRoot) {
  const manifest = JSON.parse(await readFile(manifestFile(root), 'utf8'));
  if (manifest.source !== AVATAR_SOURCE || manifest.recipe !== recipe || !/^[a-f0-9]{20}$/.test(manifest.fingerprint)) throw new Error('站点图标配置已变化，需要重新生成');
  const assets = identityAssets(manifest);
  if (assets.length !== ICON_SIZES.length + AVATAR_SIZES.length + 1) throw new Error('站点图标清单不完整');
  for (const asset of assets) {
    if (!new RegExp(`^site-identity/${manifest.fingerprint}/[a-z0-9-]+\\.(png|webp|ico)$`).test(asset.src)) throw new Error('站点图标路径无效');
    const info = await stat(path.join(root, 'static', asset.src));
    if (!info.isFile() || !info.size) throw new Error(`站点图标文件无效：${asset.src}`);
  }
  for (const alias of ['favicon.ico', 'avatar.jpg']) {
    if (!(await stat(path.join(root, 'static', alias))).size) throw new Error(`缺少兼容图标：${alias}`);
  }
  return manifest;
}

export async function prepareIdentity({ root = projectRoot, offline = false, signal, fetchImpl = fetch, timeoutMs = 12_000, log = console.log } = {}) {
  if (offline) {
    try {
      const manifest = await readIdentity(root);
      log('离线模式：显式复用本机上次生成的站点图标，不访问 GitHub');
      return manifest;
    } catch (error) { throw new Error('离线站点图标缺失或无效，请先联网运行 npm run identity', { cause: error }); }
  }
  log(`在线获取 ${AVATAR_SOURCE}（不复用下载缓存）`);
  const input = await fetchAvatar({ signal, fetchImpl, timeoutMs, log });
  // Only keep the downloaded original in memory; every deployment fetches it
  // again, even when its content hash matches the previous deployment.
  const fingerprint = createHash('sha256').update(recipe).update(input).digest('hex').slice(0, 20);
  const prefix = `site-identity/${fingerprint}`;
  const resize = size => sharp(input, { limitInputPixels: 16_777_216 }).rotate().resize(size, size, { fit: 'cover', position: 'centre' });
  const files = new Map();
  const pngs = new Map();
  for (const size of ICON_SIZES) {
    signal?.throwIfAborted();
    const bytes = await resize(size).png({ compressionLevel: 9 }).toBuffer();
    pngs.set(size, bytes);
    files.set(`${prefix}/icon-${size}.png`, bytes);
  }
  for (const size of AVATAR_SIZES) {
    signal?.throwIfAborted();
    files.set(`${prefix}/avatar-${size}.webp`, await resize(size).webp({ quality: 85 }).toBuffer());
  }
  const ico = makeICO([16, 32, 48].map(size => ({ size, bytes: pngs.get(size) })));
  files.set(`${prefix}/favicon.ico`, ico);
  const jpeg = await resize(512).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const icon = size => ({ size, src: `${prefix}/icon-${size}.png` });
  const manifest = {
    source: AVATAR_SOURCE, recipe, fingerprint, generatedAt: new Date().toISOString(),
    favicons: [16, 32, 48].map(icon), appleTouchIcon: icon(180), touchIcon: icon(192), socialImage: icon(512),
    ico: { src: `${prefix}/favicon.ico`, sizes: '16x16 32x32 48x48' },
    avatars: AVATAR_SIZES.map(size => ({ size, src: `${prefix}/avatar-${size}.webp` })),
  };
  // Encode everything before publishing any files. The manifest is committed
  // last so readers never observe a partially generated set of assets.
  signal?.throwIfAborted();
  for (const [relative, bytes] of files) await writeAsset(path.join(root, 'static', relative), bytes);
  await writeAsset(path.join(root, 'static/favicon.ico'), ico);
  await writeAsset(path.join(root, 'static/avatar.jpg'), jpeg);
  await writeJSON(manifestFile(root), manifest);
  log(`favicon 16/32/48px · Apple 180px · Android 192px · 分享图 512px`);
  log(`响应式头像 ${AVATAR_SIZES.join('/')}px · 资源指纹 ${fingerprint}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--offline')) throw new Error('用法：npm run identity [-- --offline]');
    await prepareIdentity({ offline: args.includes('--offline') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
