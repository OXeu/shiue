// 站点图标与头像的生成管线。
//
// 输入是 GitHub 头像原图；输出一组固定配方（recipe）的派生资源：
//   favicon（WebP 16/32/48 + ICO）、Apple Touch（PNG 180）、
//   应用图标（WebP 192）、分享图（PNG 512）、响应式头像（WebP 48–512）。
// 资源按内容指纹存放在 static/site-identity/<fingerprint>/，配方或原图
// 变化即产生新指纹，Hugo 模板从 data/xeu/identity.json 清单读取路径。
//
// 每次在线部署都重新拉取原图（不信任 HTTP 缓存），失败不回退旧缓存。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { writeJSON } from '../deploy/files.mjs';

export const AVATAR_SOURCE = 'https://avatars.githubusercontent.com/u/36541432';
export const AVATAR_SIZES = [48, 80, 96, 160, 192, 240, 320, 512];
export const ICON_SIZES = [16, 32, 48, 180, 192, 512];

const FAVICON_SIZES = [16, 32, 48];
const ROUNDED_ICON_SIZES = [...FAVICON_SIZES, 192];
const ICON_CORNER_RADIUS_RATIO = 0.2;

// 配方版本：校验规则或输出格式变化时递增，使全部资源指纹失效。
const recipe = JSON.stringify({
  version: 4,
  avatars: AVATAR_SIZES,
  icons: ICON_SIZES,
  webpIcons: ROUNDED_ICON_SIZES,
  webpQuality: 85,
  iconCornerRadiusRatio: ICON_CORNER_RADIUS_RATIO,
});

// GitHub 对无头像用户返回的默认占位图的 SHA-256；命中即视为获取失败。
const githubPlaceholderHash = '2ae73e12cb1e9989929920c4e9da0b02b6f6f8f0bd1944ac9ebfbf6b4dca746b';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestFile = root => path.join(root, 'data/xeu/identity.json');

/** 拼 ICO 容器：现代 ICO 直接内嵌 PNG 帧，无需额外编码器。 */
export function makeICO(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);                      // ICONDIR: 类型为图标
  header.writeUInt16LE(frames.length, 4);          // 帧数量
  let offset = header.length;
  frames.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;       // 宽（256 编码为 0）
    header[entry + 1] = size === 256 ? 0 : size;   // 高
    header.writeUInt16LE(1, entry + 4);            // 颜色数占位
    header.writeUInt16LE(32, entry + 6);           // 位深
    header.writeUInt32LE(bytes.length, entry + 8); // 帧字节数
    header.writeUInt32LE(offset, entry + 12);      // 帧数据偏移
    offset += bytes.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.bytes)]);
}

/** 拉取头像原图；失败重试一次，始终 no-store，绝不使用磁盘缓存。 */
async function fetchAvatar({ signal, fetchImpl, timeoutMs, log }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const url = new URL(AVATAR_SOURCE);
    url.searchParams.set('v', '4');
    // 重试时去掉尺寸参数，请求规范头像 URL；只用 GitHub 自己的参数。
    if (attempt === 0) url.searchParams.set('s', '512');
    try {
      const response = await fetchImpl(url.href, {
        cache: 'no-store',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: 'image/*', 'cache-control': 'no-cache', pragma: 'no-cache', 'user-agent': 'Xeu-Site-Identity/1.0' },
      });
      try {
        if (!response.ok) throw new Error(`GitHub 头像返回 HTTP ${response.status}`);
        if (!/^image\//i.test(response.headers.get('content-type') || '')) throw new Error('GitHub 头像响应不是图片');
        // 双重限长：Content-Length 头 + 流式累计，防压缩炸弹。
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

/** 原子写入：临时文件 + rename，读者不会看到半截文件。 */
async function writeAsset(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 清单中引用的全部资源（favicon、图标、头像、分享图）。 */
export function identityAssets(manifest) {
  return [
    ...manifest.favicons,
    manifest.appleTouchIcon,
    manifest.touchIcon,
    manifest.socialImage,
    manifest.ico,
    ...manifest.avatars,
  ];
}

/** 读取并严格校验现有清单；任何字段不满足当前配方都要求重新生成。 */
export async function readIdentity(root = projectRoot) {
  const manifest = JSON.parse(await readFile(manifestFile(root), 'utf8'));
  if (manifest.source !== AVATAR_SOURCE
    || manifest.recipe !== recipe
    || !/^[a-f0-9]{20}$/.test(manifest.fingerprint)) {
    throw new Error('站点图标配置已变化，需要重新生成');
  }
  const assets = identityAssets(manifest);
  if (assets.length !== ICON_SIZES.length + AVATAR_SIZES.length + 1) throw new Error('站点图标清单不完整');
  for (const asset of assets) {
    if (!new RegExp(`^site-identity/${manifest.fingerprint}/[a-z0-9-]+\\.(png|webp|ico)$`).test(asset.src)) {
      throw new Error('站点图标路径无效');
    }
    const info = await stat(path.join(root, 'static', asset.src));
    if (!info.isFile() || !info.size) throw new Error(`站点图标文件无效：${asset.src}`);
  }
  // 兼容别名：部分旧客户端只认根路径的 favicon.ico / avatar.jpg。
  for (const alias of ['favicon.ico', 'avatar.jpg']) {
    if (!(await stat(path.join(root, 'static', alias))).size) throw new Error(`缺少兼容图标：${alias}`);
  }
  return manifest;
}

/**
 * 生成全套站点图标。离线模式只校验并复用上次产物；
 * 在线模式重新拉取原图并完整重算，即使内容未变。
 */
export async function prepareIdentity({ root = projectRoot, offline = false, signal, fetchImpl = fetch, timeoutMs = 12_000, log = console.log } = {}) {
  if (offline) {
    try {
      const manifest = await readIdentity(root);
      log('离线模式：显式复用本机上次生成的站点图标，不访问 GitHub');
      return manifest;
    } catch (error) {
      throw new Error('离线站点图标缺失或无效，请先联网运行 npm run identity', { cause: error });
    }
  }

  log(`在线获取 ${AVATAR_SOURCE}（不复用下载缓存）`);
  const input = await fetchAvatar({ signal, fetchImpl, timeoutMs, log });
  // 原图只在内存中保留；每次部署都重新拉取，指纹只用于定位资源路径。
  const fingerprint = createHash('sha256').update(recipe).update(input).digest('hex').slice(0, 20);
  const prefix = `site-identity/${fingerprint}`;

  const resize = size =>
    sharp(input, { limitInputPixels: 16_777_216 }).rotate().resize(size, size, { fit: 'cover', position: 'centre' });
  // 圆角图标：以 SVG 矩形做 dest-in 合成，实现透明圆角。
  const roundedIcon = size => {
    const radius = size * ICON_CORNER_RADIUS_RATIO;
    const mask = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`);
    return resize(size).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]);
  };

  // 浏览器图标统一 WebP；ICO 用小尺寸 PNG 帧；Apple Touch 与分享图保持
  // PNG 以兼容旧解析器。
  const files = new Map();
  const pngs = new Map();

  for (const size of FAVICON_SIZES) {
    signal?.throwIfAborted();
    pngs.set(size, await roundedIcon(size).png({ compressionLevel: 9 }).toBuffer());
  }
  for (const size of ROUNDED_ICON_SIZES) {
    signal?.throwIfAborted();
    files.set(`${prefix}/icon-${size}.webp`, await roundedIcon(size).webp({ quality: 85 }).toBuffer());
  }
  for (const size of [180, 512]) {
    signal?.throwIfAborted();
    files.set(`${prefix}/icon-${size}.png`, await resize(size).png({ compressionLevel: 9 }).toBuffer());
  }
  for (const size of AVATAR_SIZES) {
    signal?.throwIfAborted();
    files.set(`${prefix}/avatar-${size}.webp`, await resize(size).webp({ quality: 85 }).toBuffer());
  }

  const ico = makeICO([16, 32, 48].map(size => ({ size, bytes: pngs.get(size) })));
  files.set(`${prefix}/favicon.ico`, ico);
  const jpeg = await resize(512).jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  const icon = (size, format) => ({ size, src: `${prefix}/icon-${size}.${format}` });
  const manifest = {
    source: AVATAR_SOURCE,
    recipe,
    fingerprint,
    generatedAt: new Date().toISOString(),
    favicons: FAVICON_SIZES.map(size => icon(size, 'webp')),
    appleTouchIcon: icon(180, 'png'),
    touchIcon: icon(192, 'webp'),
    socialImage: icon(512, 'png'),
    ico: { src: `${prefix}/favicon.ico`, sizes: '16x16 32x32 48x48' },
    avatars: AVATAR_SIZES.map(size => ({ size, src: `${prefix}/avatar-${size}.webp` })),
  };

  // 先编码全部文件再落盘；清单最后写，读者不会观察到半套资源。
  signal?.throwIfAborted();
  for (const [relative, bytes] of files) await writeAsset(path.join(root, 'static', relative), bytes);
  await writeAsset(path.join(root, 'static/favicon.ico'), ico);
  await writeAsset(path.join(root, 'static/avatar.jpg'), jpeg);
  await writeJSON(manifestFile(root), manifest);

  log('WebP favicon 16/32/48px · Apple PNG 180px · WebP 应用图标 192px · PNG 分享图 512px');
  log(`响应式头像 ${AVATAR_SIZES.join('/')}px · 资源指纹 ${fingerprint}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--offline')) throw new Error('用法：npm run identity [-- --offline]');
    await prepareIdentity({ offline: args.includes('--offline') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
