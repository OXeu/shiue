import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, access, rename, copyFile, stat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cacache from 'cacache';
import sharp from 'sharp';
import { encode, isBlurhashValid } from 'blurhash';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const widths = [320, 480, 640, 768, 960, 1440];
// 保持画质，使用更充分的构建时压缩；配置变化自动使旧缩略图缓存失效。
const webpOptions = { quality: 78, effort: 6 };
const recipe = JSON.stringify({ version: 2, widths, webp: webpOptions, blurhash: [4, 3] });
const recipeId = createHash('sha256').update(recipe).digest('hex').slice(0, 16);
const workerCachePrefix = `xeu-images:${recipeId}`;
const workerIndexKey = `${workerCachePrefix}:index`;
const isCandidate = name => /\.(avif|gif|jpe?g|png|webp|tiff?)$/i.test(name) || !path.extname(name);
const exists = file => access(file).then(() => true, () => false);
const hasImage = file => stat(file).then(info => info.isFile() && info.size > 0, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const variantWidths = width => [...new Set(widths.map(size => Math.min(size, width)))];

async function readManifest(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

function validEntry(entry, fingerprint) {
  if (!entry || entry.fingerprint !== fingerprint || !Number.isInteger(entry.width) || entry.width <= 0
    || !Number.isInteger(entry.height) || entry.height <= 0 || typeof entry.blurhash !== 'string'
    || !isBlurhashValid(entry.blurhash).result || !Array.isArray(entry.variants)) return false;
  const expected = variantWidths(entry.width);
  return entry.variants.length === expected.length && entry.variants.every((item, index) =>
    item?.width === expected[index] && item.src === `xeu-images/${fingerprint}-${item.width}.webp`);
}

async function copyImage(source, target) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temp);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

async function writeImage(data, target) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

async function readContentCache(cache, key) {
  try {
    return (await cacache.get(cache, key)).data;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EINTEGRITY') return;
    throw error;
  }
}

async function readContentCacheJSON(cache, key, fallback) {
  const data = await readContentCache(cache, key);
  if (!data) return fallback;
  try { return JSON.parse(data.toString('utf8')); }
  catch { return fallback; }
}

const workerEntryKey = fingerprint => `${workerCachePrefix}:entry:${fingerprint}`;
const workerVariantKey = (fingerprint, width) => `${workerCachePrefix}:variant:${fingerprint}:${width}`;

async function sources(root, directory) {
  const folder = path.join(root, directory);
  const found = [];
  if (!await exists(folder)) return found;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (['static/xeu-images', 'static/site-identity', 'static/avatar.jpg'].includes(relative)) continue;
    if (entry.isDirectory()) found.push(...await sources(root, relative));
    else if (entry.isFile() && isCandidate(entry.name)) found.push(relative);
  }
  return found.sort();
}

export async function prepareImages(root = projectRoot, {
  log = console.log,
  onProgress,
  buildEnv = process.env,
  homeDirectory = homedir(),
} = {}) {
  const manifestPath = path.join(root, 'data/xeu/images.json');
  const destination = path.join(root, 'static/xeu-images');
  const workerBuild = buildEnv.WORKERS_CI === '1';
  const configuredNpmCache = buildEnv.NPM_CONFIG_CACHE || buildEnv.npm_config_cache;
  const npmCache = configuredNpmCache ? path.resolve(root, configuredNpmCache) : path.join(homeDirectory, '.npm');
  const workerCache = path.join(npmCache, '_cacache');
  // Vercel 的 Other 构建器默认保存 node_modules；安装入口会在 npm ci 前后保留此目录。
  const cache = path.join(root, 'node_modules/.cache/xeu-images');
  const cacheManifestPath = path.join(cache, 'images.json');
  const cacheFiles = path.join(cache, 'files');
  await mkdir(destination, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  if (!workerBuild) await mkdir(cacheFiles, { recursive: true });
  const previousText = await readFile(manifestPath, 'utf8').catch(() => '{}');
  const previous = await readManifest(manifestPath);
  const persisted = workerBuild ? {} : await readManifest(cacheManifestPath);
  const workerIndex = workerBuild
    ? await readContentCacheJSON(workerCache, workerIndexKey, { fingerprints: [], keys: [] })
    : { fingerprints: [], keys: [] };
  const byFingerprint = new Map(Object.values(persisted).filter(entry => /^[a-f0-9]{24}$/.test(entry?.fingerprint))
    .map(entry => [entry.fingerprint, entry]));
  const manifest = {};
  let generated = 0;
  let restored = 0;
  // 有限并发，避免多个大图解码同时占满构建机器内存。
  const queue = [...await sources(root, 'content'), ...await sources(root, 'static')];
  const processImage = async source => {
    const input = await readFile(path.join(root, source));
    const fingerprint = createHash('sha256').update(recipe).update(input).digest('hex').slice(0, 24);
    const workerEntry = workerBuild
      ? await readContentCacheJSON(workerCache, workerEntryKey(fingerprint), undefined)
      : undefined;
    for (const cached of [previous[source], byFingerprint.get(fingerprint), workerEntry]) {
      if (!validEntry(cached, fingerprint)) continue;
      let complete = true;
      let recovered = false;
      for (const item of cached.variants) {
        const target = path.join(root, 'static', item.src);
        if (await hasImage(target)) continue;
        if (workerBuild) {
          const data = await readContentCache(workerCache, workerVariantKey(fingerprint, item.width));
          if (data?.length) {
            await writeImage(data, target);
            recovered = true;
            continue;
          }
        } else {
          const saved = path.join(cacheFiles, path.basename(item.src));
          if (await hasImage(saved)) {
            await copyImage(saved, target);
            recovered = true;
            continue;
          }
        }
        complete = false;
        break;
      }
      if (complete) {
        manifest[source] = cached;
        if (recovered) restored++;
        return;
      }
    }
    let metadata;
    try { metadata = await sharp(input, { animated: true }).metadata(); }
    catch (error) {
      if (!path.extname(source)) return;
      throw new Error(`无法处理图片 ${source}`, { cause: error });
    }
    if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(metadata.format)) return;
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    const width = rotated ? (metadata.pageHeight || metadata.height) : metadata.width;
    const height = rotated ? metadata.width : (metadata.pageHeight || metadata.height);
    const variants = [];
    for (const size of variantWidths(width)) {
      const name = `${fingerprint}-${size}.webp`;
      const target = path.join(destination, name);
      if (!await hasImage(target)) {
        const sourceKey = createHash('sha256').update(source).digest('hex').slice(0, 12);
        const temp = `${target}.${process.pid}.${sourceKey}.tmp`;
        await sharp(input, { animated: true }).rotate().resize({ width: size, withoutEnlargement: true }).webp(webpOptions).toFile(temp);
        await rename(temp, target);
      }
      variants.push({ src: `xeu-images/${name}`, width: size });
    }
    const { data, info } = await sharp(input, { page: 0, pages: 1 }).rotate()
      .resize(32, 32, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    manifest[source] = { fingerprint, width, height, blurhash: encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3), variants };
    generated++;
  };
  const total = queue.length;
  let completed = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const source = queue.shift();
      await processImage(source);
      onProgress?.({ completed: ++completed, total, source });
    }
  }));
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (text !== previousText) {
    const temp = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temp, text);
    await rename(temp, manifestPath);
  }
  const activeFiles = new Set(Object.values(sorted).flatMap(entry => entry.variants.map(item => path.basename(item.src))));
  const totalImages = Object.keys(sorted).length;
  if (workerBuild) {
    // Workers Builds 明确恢复 npm 的全局缓存。把条目写进 npm 自身使用的
    // _cacache，而不是旁挂自定义目录，确保它属于平台会保存的内容缓存。
    const activeKeys = new Set([workerIndexKey]);
    for (const entry of Object.values(sorted)) {
      const entryKey = workerEntryKey(entry.fingerprint);
      activeKeys.add(entryKey);
      await cacache.put(workerCache, entryKey, JSON.stringify(entry));
      for (const item of entry.variants) {
        const variantKey = workerVariantKey(entry.fingerprint, item.width);
        activeKeys.add(variantKey);
        await cacache.put(workerCache, variantKey, await readFile(path.join(root, 'static', item.src)));
      }
    }
    for (const key of Array.isArray(workerIndex.keys) ? workerIndex.keys : []) {
      if (typeof key === 'string' && key.startsWith(`${workerCachePrefix}:`) && !activeKeys.has(key)) {
        await cacache.rm.entry(workerCache, key);
      }
    }
    await cacache.put(workerCache, workerIndexKey, JSON.stringify({
      images: totalImages,
      fingerprints: [...new Set(Object.values(sorted).map(entry => entry.fingerprint))],
      keys: [...activeKeys],
    }));
  } else {
    for (const name of activeFiles) {
      const saved = path.join(cacheFiles, name);
      if (!await hasImage(saved)) await copyImage(path.join(destination, name), saved);
    }
    if (await readFile(cacheManifestPath, 'utf8').catch(() => '') !== text) {
      const temp = `${cacheManifestPath}.${process.pid}.tmp`;
      await writeFile(temp, text);
      await rename(temp, cacheManifestPath);
    }
    // 只保留当前图片使用的缓存，避免内容更新后旧指纹无限累积。
    for (const name of await readdir(cacheFiles)) {
      if (/^[a-f0-9]{24}-\d+\.webp$/.test(name) && !activeFiles.has(name)) await rm(path.join(cacheFiles, name));
    }
  }
  const summary = `图片准备完成：${totalImages} 张图片，缓存复用 ${totalImages - generated} 张（从构建缓存恢复 ${restored} 张），${generated} 张新生成缩略图与 BlurHash。`;
  const workerIndexSize = Number.isInteger(workerIndex.images) ? workerIndex.images : 0;
  log(workerBuild ? `${summary} Cloudflare npm 内容缓存恢复索引 ${workerIndexSize} 张，目录 ${workerCache}。` : summary);
  return sorted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareImages();
  if (process.argv.includes('--watch')) {
    let timer;
    let pending = Promise.resolve();
    for (const directory of ['content', 'static']) {
      watch(path.join(projectRoot, directory), { recursive: true }, (_event, name) => {
        if (!name || name.startsWith('xeu-images') || name.startsWith('site-identity') || name === 'avatar.jpg' || !isCandidate(name)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          pending = pending.then(() => prepareImages()).catch(error => console.error(error));
        }, 250);
      });
    }
    console.log('正在监听图片变化…');
  }
}
