// 文章图片的多档位生成管线。
//
// 每张内容图片生成两个派生档（未改写的源文件即“原图”档）：
//   thumbnail  640px WebP —— 列表卡片与小屏预览
//   medium    1600px WebP —— 760px 正文在 2x 屏上的显示需求
// 同时为每张图计算 BlurHash（4x3），供模板做占位渐显。
//
// 产物按「配方 + 原图内容」的指纹命名（static/xeu-images/<指纹>-<宽>.webp），
// 内容相同的图片只编码一次；构建产物镜像到 .cache/xeu-images/，
// Cloudflare Workers Builds 会跨构建保留项目 .cache，从而命中缓存。

import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, access, rename, copyFile, stat, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encode, isBlurhashValid } from 'blurhash';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const renditions = [
  {
    role: 'thumbnail', width: 640,
    webp: { quality: 76, effort: 6, smartSubsample: true },
    adaptive: { maxBitsPerPixel: 1.25, minQuality: 62 },
  },
  { role: 'medium', width: 1600, webp: { quality: 82, effort: 6, smartSubsample: true } },
];
const recipe = JSON.stringify({ version: 4, renditions, blurhash: [4, 3] });
const legacyPublicCacheFiles = ['image-cache-v3.json', 'image-cache-v3.bin'];

const isCandidate = name => /\.(avif|gif|jpe?g|png|webp|tiff?)$/i.test(name) || !path.extname(name);
const exists = file => access(file).then(() => true, () => false);
const hasImage = file => stat(file).then(
  info => info.isFile() && info.size > 0,
  error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  },
);

/** 每个指纹应有的两个档位；小图上宽度截到原图宽（不放大）。 */
const expectedVariants = (width, fingerprint) => renditions.map(item => ({
  role: item.role,
  width: Math.min(item.width, width),
  src: `xeu-images/${fingerprint}-${Math.min(item.width, width)}.webp`,
}));

/** 小原图上两个档位可能退化为同一文件，去重得到实际文件列表。 */
const uniqueVariants = entry => [...new Map(entry.variants.map(item => [item.src, item])).values()];

function resolveConcurrency(buildEnv, override) {
  const requested = Number(override ?? buildEnv.SHIUE_IMAGE_CONCURRENCY);
  if (Number.isInteger(requested) && requested > 0) return Math.min(requested, 12);
  return Math.min(6, Math.max(2, availableParallelism()));
}

export function imageCacheDirectory(root) {
  return path.join(root, '.cache/xeu-images');
}

/** 有界并发执行：固定数量工人从共享游标取任务。 */
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
    // 清单缺失或损坏都视为空清单，全量重建。
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

/** 缓存条目是否完整可用：指纹、尺寸、BlurHash 与全部档位文件。 */
function validEntry(entry, fingerprint) {
  if (!entry
    || entry.fingerprint !== fingerprint
    || !Number.isInteger(entry.width) || entry.width <= 0
    || !Number.isInteger(entry.height) || entry.height <= 0
    || typeof entry.blurhash !== 'string'
    || !isBlurhashValid(entry.blurhash).result
    || !Array.isArray(entry.variants)) return false;
  const expected = expectedVariants(entry.width, fingerprint);
  return entry.variants.length === expected.length
    && entry.variants.every((item, index) =>
      item?.role === expected[index].role && item.width === expected[index].width && item.src === expected[index].src);
}

/** 原子复制：临时文件 + rename。 */
async function copyImage(source, target) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temp);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

/** 渲染一档 WebP；启用自适应质量时二分搜索满足体积上限的质量。 */
async function renderWebp(pipeline, target, { width, webp, adaptive }) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const resized = pipeline.clone().resize({ width, withoutEnlargement: true });
    const encode = quality => resized.clone().webp({ ...webp, quality }).toBuffer({ resolveWithObject: true });
    let output = await encode(webp.quality);
    if (adaptive) {
      // 体积超过 bpp 上限时，在 [minQuality, quality-1] 内二分找最优质量。
      const maxBytes = Math.ceil(output.info.width * output.info.height * adaptive.maxBitsPerPixel / 8);
      if (output.data.length > maxBytes) {
        let low = adaptive.minQuality;
        let high = webp.quality - 1;
        let selected = await encode(low);
        while (low <= high) {
          const quality = Math.floor((low + high) / 2);
          const candidate = await encode(quality);
          if (candidate.data.length <= maxBytes) {
            selected = candidate;
            low = quality + 1;
          } else high = quality - 1;
        }
        output = selected;
      }
    }
    await writeFile(temp, output.data, { flag: 'wx' });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

/** 递归收集内容与静态目录中的候选图片（排除本管线自己的产物）。 */
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

/** 尝试用缓存条目恢复产物：文件缺失时从 .cache 镜像补回。 */
async function tryRestore(cached, fingerprint, cacheFiles, root) {
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
  return complete ? { entry: cached, recovered } : undefined;
}

/** 读取图片元数据；EXIF 旋转后宽高需互换；格式不支持返回 undefined。 */
async function readMetadata(input) {
  let metadata;
  try {
    metadata = await sharp(input, { animated: true }).metadata();
  } catch (error) {
    throw new Error('decode-failed', { cause: error });
  }
  if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(metadata.format)) return undefined;
  const rotated = [5, 6, 7, 8].includes(metadata.orientation);
  return {
    format: metadata.format,
    width: rotated ? (metadata.pageHeight || metadata.height) : metadata.width,
    height: rotated ? metadata.width : (metadata.pageHeight || metadata.height),
  };
}

/**
 * 生成全部图片档位与 BlurHash，写 data/xeu/images.json 清单。
 *
 * 处理顺序：按内容指纹分组（重复图只处理一次）→ 查产物与 .cache 两级缓存
 * → 未命中才解码、缩放、编码、算 BlurHash → 清理不再引用的派生文件。
 */
export async function prepareImages(root = projectRoot, {
  log = console.log,
  onProgress,
  buildEnv = process.env,
  concurrency,
} = {}) {
  const manifestPath = path.join(root, 'data/xeu/images.json');
  const destination = path.join(root, 'static/xeu-images');
  const imageConcurrency = resolveConcurrency(buildEnv, concurrency);
  const cache = imageCacheDirectory(root);
  const cacheManifestPath = path.join(cache, 'images.json');
  const cacheFiles = path.join(cache, 'files');

  await mkdir(destination, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await mkdir(cacheFiles, { recursive: true });
  // 清掉旧版本遗留在 public 内的缓存文件。
  await Promise.all(legacyPublicCacheFiles.map(name => rm(path.join(destination, name), { force: true })));

  const previousText = await readFile(manifestPath, 'utf8').catch(() => '{}');
  const previous = await readManifest(manifestPath);
  const persisted = await readManifest(cacheManifestPath);
  const byFingerprint = new Map(
    Object.values(persisted)
      .filter(entry => /^[a-f0-9]{24}$/.test(entry?.fingerprint))
      .map(entry => [entry.fingerprint, entry]),
  );

  const manifest = {};
  let generated = 0;
  let generatedUnique = 0;
  let restored = 0;

  // 第一步：按内容指纹分组，同图只保留一份输入。
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

  // 第二步：逐组处理——先查缓存，未命中再编码。
  await runConcurrent(groups, imageConcurrency, async group => {
    const { fingerprint, input } = group;
    const previousEntry = group.sources.map(source => previous[source]).find(Boolean);

    let cachedResult;
    for (const cached of [previousEntry, byFingerprint.get(fingerprint)]) {
      cachedResult = await tryRestore(cached, fingerprint, cacheFiles, root);
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
    try {
      metadata = await readMetadata(input);
    } catch (error) {
      // 解码失败：无扩展名的候选多半是误报（文本等），跳过不报错；
      // 有扩展名的图片必须能解码，否则构建失败。
      completed += group.sources.length;
      onProgress?.({ completed, total, source: group.sources.at(-1) });
      if (!group.sources.some(source => path.extname(source))) return;
      throw new Error(`无法处理图片 ${group.sources[0]}`, { cause: error });
    }
    if (!metadata) {
      // 格式不在支持列表：非图片候选（如无扩展名文本），跳过。
      completed += group.sources.length;
      onProgress?.({ completed, total, source: group.sources.at(-1) });
      return;
    }

    const variants = expectedVariants(metadata.width, fingerprint);
    // 小原图上两档可能退化为同一宽度；保留质量更高的配置（medium 优先）。
    const outputs = new Map();
    for (const rendition of renditions) {
      const outputWidth = Math.min(rendition.width, metadata.width);
      outputs.set(outputWidth, { width: outputWidth, webp: rendition.webp, adaptive: rendition.adaptive });
    }

    const pipeline = sharp(input, { animated: true }).rotate();
    // BlurHash 取第一帧、白底、RGBA 原始像素；与档位编码并行。
    const blurhashPromise = sharp(input, { page: 0, pages: 1 }).rotate()
      .resize(32, 32, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    await Promise.all([...outputs.values()].map(async output => {
      const target = path.join(destination, `${fingerprint}-${output.width}.webp`);
      if (!await hasImage(target)) await renderWebp(pipeline, target, output);
    }));

    const { data, info } = await blurhashPromise;
    const entry = {
      fingerprint,
      width: metadata.width,
      height: metadata.height,
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

  // 第三步：写清单（内容有变才写）、同步 .cache 镜像、清理陈旧派生文件。
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (text !== previousText) {
    const temp = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temp, text);
    await rename(temp, manifestPath);
  }

  const activeFiles = new Set(
    Object.values(sorted).flatMap(entry => uniqueVariants(entry).map(item => path.basename(item.src))),
  );
  const totalImages = Object.keys(sorted).length;

  // 配方或原图变化后移除不再引用的派生文件，避免 Hugo 发布旧档位。
  for (const name of await readdir(destination)) {
    if (/^[a-f0-9]{24}-\d+\.webp$/.test(name) && !activeFiles.has(name)) {
      await rm(path.join(destination, name));
    }
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
    if (/^[a-f0-9]{24}-\d+\.webp$/.test(name) && !activeFiles.has(name)) {
      await rm(path.join(cacheFiles, name));
    }
  }

  log(`图片准备完成：${totalImages} 张图片，缓存复用 ${totalImages - generated} 张（从构建缓存恢复 ${restored} 张），${generated} 张新生成缩略图与 BlurHash（${generatedUnique} 份唯一内容）；并发 ${imageConcurrency}。`);
  return sorted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareImages();
  if (process.argv.includes('--watch')) {
    // 防抖：250ms 内的连续变更只触发一次重建。
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
