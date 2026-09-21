import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, access, rename, copyFile, stat, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encode, isBlurhashValid } from 'blurhash';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 只生成两个派生文件；未经改写的源文件就是第三档“原图”。
// 640px 覆盖列表卡片和小屏预览，1600px 覆盖 760px 正文在 2x 屏上的显示需求。
const renditions = [
  { role: 'thumbnail', width: 640, webp: { quality: 76, effort: 4, smartSubsample: true } },
  { role: 'medium', width: 1600, webp: { quality: 82, effort: 4, smartSubsample: true } },
];
const recipe = JSON.stringify({ version: 3, renditions, blurhash: [4, 3] });
const legacyPublicCacheFiles = ['image-cache-v3.json', 'image-cache-v3.bin'];
const isCandidate = name => /\.(avif|gif|jpe?g|png|webp|tiff?)$/i.test(name) || !path.extname(name);
const exists = file => access(file).then(() => true, () => false);
const hasImage = file => stat(file).then(info => info.isFile() && info.size > 0, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const expectedVariants = (width, fingerprint) => renditions.map(item => ({
  role: item.role,
  width: Math.min(item.width, width),
  src: `xeu-images/${fingerprint}-${Math.min(item.width, width)}.webp`,
}));
const uniqueVariants = entry => [...new Map(entry.variants.map(item => [item.src, item])).values()];

function resolveConcurrency(buildEnv, override) {
  const requested = Number(override ?? buildEnv.SHIUE_IMAGE_CONCURRENCY);
  if (Number.isInteger(requested) && requested > 0) return Math.min(requested, 12);
  return Math.min(6, Math.max(2, availableParallelism()));
}

export function imageCacheDirectory(root) {
  return path.join(root, '.cache/xeu-images');
}

async function runConcurrent(items, concurrency, task) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  }));
}

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
  const expected = expectedVariants(entry.width, fingerprint);
  return entry.variants.length === expected.length && entry.variants.every((item, index) =>
    item?.role === expected[index].role && item.width === expected[index].width && item.src === expected[index].src);
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

async function renderWebp(pipeline, target, width, options) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await pipeline.clone().resize({ width, withoutEnlargement: true }).webp(options).toFile(temp);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

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
  concurrency,
} = {}) {
  const manifestPath = path.join(root, 'data/xeu/images.json');
  const destination = path.join(root, 'static/xeu-images');
  const imageConcurrency = resolveConcurrency(buildEnv, concurrency);
  // 唯一的构建缓存位置；Cloudflare Workers Builds 会跨构建保存项目 .cache。
  const cache = imageCacheDirectory(root);
  const cacheManifestPath = path.join(cache, 'images.json');
  const cacheFiles = path.join(cache, 'files');
  await mkdir(destination, { recursive: true });
  await Promise.all(legacyPublicCacheFiles.map(name => rm(path.join(destination, name), { force: true })));
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await mkdir(cacheFiles, { recursive: true });
  const previousText = await readFile(manifestPath, 'utf8').catch(() => '{}');
  const previous = await readManifest(manifestPath);
  const persisted = await readManifest(cacheManifestPath);
  const byFingerprint = new Map(Object.values(persisted).filter(entry => /^[a-f0-9]{24}$/.test(entry?.fingerprint))
    .map(entry => [entry.fingerprint, entry]));
  const manifest = {};
  let generated = 0;
  let generatedUnique = 0;
  let restored = 0;

  // 先按内容指纹分组：重复图片只解码、压缩和计算 BlurHash 一次。
  const queue = [...await sources(root, 'content'), ...await sources(root, 'static')];
  const groupsByFingerprint = new Map();
  await runConcurrent(queue, imageConcurrency, async source => {
    const input = await readFile(path.join(root, source));
    const fingerprint = createHash('sha256').update(recipe).update(input).digest('hex').slice(0, 24);
    const group = groupsByFingerprint.get(fingerprint);
    if (group) group.sources.push(source);
    else groupsByFingerprint.set(fingerprint, { fingerprint, input, sources: [source] });
  });
  const groups = [...groupsByFingerprint.values()];
  const total = queue.length;
  let completed = 0;

  await runConcurrent(groups, imageConcurrency, async group => {
    const { fingerprint, input } = group;
    const previousEntry = group.sources.map(source => previous[source]).find(Boolean);
    const tryCached = async cached => {
      if (!validEntry(cached, fingerprint)) return undefined;
      let complete = true;
      let recovered = false;
      for (const item of uniqueVariants(cached)) {
        const target = path.join(root, 'static', item.src);
        if (await hasImage(target)) continue;
        const saved = path.join(cacheFiles, path.basename(item.src));
        if (await hasImage(saved)) {
          await copyImage(saved, target);
          recovered = true;
          continue;
        }
        complete = false;
        break;
      }
      if (complete) {
        return { entry: cached, recovered };
      }
      return undefined;
    };
    let cachedResult;
    for (const cached of [previousEntry, byFingerprint.get(fingerprint)]) {
      cachedResult = await tryCached(cached);
      if (cachedResult) break;
    }
    if (cachedResult) {
      for (const source of group.sources) manifest[source] = cachedResult.entry;
      if (cachedResult.recovered) restored += group.sources.length;
      completed += group.sources.length;
      onProgress?.({ completed, total, source: group.sources.at(-1) });
      return;
    }
    let metadata;
    try { metadata = await sharp(input, { animated: true }).metadata(); }
    catch (error) {
      completed += group.sources.length;
      onProgress?.({ completed, total, source: group.sources.at(-1) });
      if (!group.sources.some(source => path.extname(source))) return;
      throw new Error(`无法处理图片 ${group.sources[0]}`, { cause: error });
    }
    if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(metadata.format)) {
      completed += group.sources.length;
      onProgress?.({ completed, total, source: group.sources.at(-1) });
      return;
    }
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    const width = rotated ? (metadata.pageHeight || metadata.height) : metadata.width;
    const height = rotated ? metadata.width : (metadata.pageHeight || metadata.height);
    const variants = expectedVariants(width, fingerprint);
    const outputs = new Map();
    for (const rendition of renditions) {
      const outputWidth = Math.min(rendition.width, width);
      // 两个角色在小原图上可能共用一个文件，采用正文档更高的质量配置。
      outputs.set(outputWidth, { width: outputWidth, options: rendition.webp });
    }
    const pipeline = sharp(input, { animated: true }).rotate();
    const blurhashPromise = sharp(input, { page: 0, pages: 1 }).rotate()
      .resize(32, 32, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    await Promise.all([...outputs.values()].map(async output => {
      const target = path.join(destination, `${fingerprint}-${output.width}.webp`);
      if (!await hasImage(target)) await renderWebp(pipeline, target, output.width, output.options);
    }));
    const { data, info } = await blurhashPromise;
    const entry = {
      fingerprint,
      width,
      height,
      blurhash: encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3),
      variants,
    };
    for (const source of group.sources) manifest[source] = entry;
    byFingerprint.set(fingerprint, entry);
    generated += group.sources.length;
    generatedUnique++;
    completed += group.sources.length;
    onProgress?.({ completed, total, source: group.sources.at(-1) });
  });
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (text !== previousText) {
    const temp = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temp, text);
    await rename(temp, manifestPath);
  }
  const activeFiles = new Set(Object.values(sorted).flatMap(entry => uniqueVariants(entry).map(item => path.basename(item.src))));
  const totalImages = Object.keys(sorted).length;
  // 配方或原图变化后及时移除不再引用的派生文件，避免 Hugo 和 Wrangler 发布旧档位。
  for (const name of await readdir(destination)) {
    if (/^[a-f0-9]{24}-\d+\.webp$/.test(name) && !activeFiles.has(name)) await rm(path.join(destination, name));
  }
  await runConcurrent([...activeFiles], imageConcurrency, async name => {
    const saved = path.join(cacheFiles, name);
    if (!await hasImage(saved)) await copyImage(path.join(destination, name), saved);
  });
  if (await readFile(cacheManifestPath, 'utf8').catch(() => '') !== text) {
    const temp = `${cacheManifestPath}.${process.pid}.tmp`;
    await writeFile(temp, text);
    await rename(temp, cacheManifestPath);
  }
  // 只保留当前图片使用的缓存，避免内容更新后旧指纹无限累积。
  for (const name of await readdir(cacheFiles)) {
    if (/^[a-f0-9]{24}-\d+\.webp$/.test(name) && !activeFiles.has(name)) await rm(path.join(cacheFiles, name));
  }
  const summary = `图片准备完成：${totalImages} 张图片，缓存复用 ${totalImages - generated} 张（从构建缓存恢复 ${restored} 张），${generated} 张新生成缩略图与 BlurHash（${generatedUnique} 份唯一内容）；并发 ${imageConcurrency}。`;
  log(summary);
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
