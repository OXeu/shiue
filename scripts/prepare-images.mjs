import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encode } from 'blurhash';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const widths = [320, 640, 960, 1440];
const recipe = 'v1-webp-q78-blurhash4x3';
const isCandidate = name => /\.(avif|gif|jpe?g|png|webp|tiff?)$/i.test(name) || !path.extname(name);
const exists = file => access(file).then(() => true, () => false);

async function sources(root, directory) {
  const folder = path.join(root, directory);
  const found = [];
  if (!await exists(folder)) return found;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (relative === 'static/xeu-images') continue;
    if (entry.isDirectory()) found.push(...await sources(root, relative));
    else if (entry.isFile() && isCandidate(entry.name)) found.push(relative);
  }
  return found.sort();
}

export async function prepareImages(root = projectRoot) {
  const manifestPath = path.join(root, 'data/xeu/images.json');
  const destination = path.join(root, 'static/xeu-images');
  await mkdir(destination, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const previousText = await readFile(manifestPath, 'utf8').catch(() => '{}');
  const previous = JSON.parse(previousText);
  const manifest = {};
  let generated = 0;
  // 有限并发，避免多个大图解码同时占满构建机器内存。
  const queue = [...await sources(root, 'content'), ...await sources(root, 'static')];
  const processImage = async source => {
    const input = await readFile(path.join(root, source));
    const fingerprint = createHash('sha256').update(recipe).update(input).digest('hex').slice(0, 24);
    const cached = previous[source];
    if (cached?.fingerprint === fingerprint && (await Promise.all(cached.variants.map(item => exists(path.join(root, 'static', item.src))))).every(Boolean)) {
      manifest[source] = cached;
      return;
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
    for (const size of [...new Set(widths.map(size => Math.min(size, width)))]) {
      const name = `${fingerprint}-${size}.webp`;
      const target = path.join(destination, name);
      if (!await exists(target)) {
        const sourceKey = createHash('sha256').update(source).digest('hex').slice(0, 12);
        const temp = `${target}.${process.pid}.${sourceKey}.tmp`;
        await sharp(input, { animated: true }).rotate().resize({ width: size, withoutEnlargement: true }).webp({ quality: 78, effort: 4 }).toFile(temp);
        await rename(temp, target);
      }
      variants.push({ src: `xeu-images/${name}`, width: size });
    }
    const { data, info } = await sharp(input, { page: 0, pages: 1 }).rotate()
      .resize(32, 32, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    manifest[source] = { fingerprint, width, height, blurhash: encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3), variants };
    generated++;
  };
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) await processImage(queue.shift());
  }));
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (text !== previousText) {
    const temp = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temp, text);
    await rename(temp, manifestPath);
  }
  console.log(`图片准备完成：${Object.keys(sorted).length} 张图片，${generated} 张新生成缩略图与 BlurHash。`);
  return sorted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareImages();
  if (process.argv.includes('--watch')) {
    let timer;
    let pending = Promise.resolve();
    for (const directory of ['content', 'static']) {
      watch(path.join(projectRoot, directory), { recursive: true }, (_event, name) => {
        if (!name || name.startsWith('xeu-images') || !isCandidate(name)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          pending = pending.then(() => prepareImages()).catch(error => console.error(error));
        }, 250);
      });
    }
    console.log('正在监听图片变化…');
  }
}
