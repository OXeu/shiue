import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { isBlurhashValid } from 'blurhash';
import { prepareImages } from './prepare-images.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'xeu-images-test-'));
await mkdir(path.join(root, 'content/post/example'), { recursive: true });
await mkdir(path.join(root, 'static/images'), { recursive: true });
const source = path.join(root, 'static/images/cover.jpg');
await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#e07a8e' } }).jpeg().toFile(source);
await copyFile(source, path.join(root, 'content/post/example/extensionless'));
await writeFile(path.join(root, 'content/post/example/README'), '不是图片');
await sharp({ create: { width: 40, height: 20, channels: 4, background: '#4288bb' } }).png().toFile(path.join(root, 'static/images/small.png'));

const first = await prepareImages(root);
assert.equal(Object.keys(first).length, 3);
const cover = first['static/images/cover.jpg'];
assert.ok(isBlurhashValid(cover.blurhash).result);
assert.deepEqual(cover.variants.map(item => item.width), [320, 480, 640, 768, 960, 1440]);
assert.deepEqual(first['content/post/example/extensionless'], cover, '无扩展名和重复图片应生成相同结果');
assert.deepEqual(first['static/images/small.png'].variants.map(item => item.width), [40], '小图不得放大');
for (const variant of cover.variants) {
  const metadata = await sharp(path.join(root, 'static', variant.src)).metadata();
  assert.equal(metadata.width, variant.width, 'srcset 宽度必须与实际文件一致');
  assert.equal(metadata.height, Math.round(variant.width * 2 / 3), '缩略图应保留原始比例');
}
const before = await stat(path.join(root, 'static', cover.variants[0].src));
const manifestBefore = await readFile(path.join(root, 'data/xeu/images.json'), 'utf8');
const second = await prepareImages(root);
assert.deepEqual(second, first);
assert.equal((await stat(path.join(root, 'static', cover.variants[0].src))).mtimeMs, before.mtimeMs, '缓存命中不应重写图片');
assert.equal(await readFile(path.join(root, 'data/xeu/images.json'), 'utf8'), manifestBefore);
// 旧配置缓存不能跳过新增档位；磁盘上缺少任何档位时必须恢复。
await writeFile(path.join(root, 'data/xeu/images.json'), JSON.stringify({
  ...first, 'static/images/cover.jpg': { ...cover, fingerprint: 'old-recipe', variants: cover.variants.filter(item => item.width !== 768) },
}));
assert.deepEqual(await prepareImages(root), first, '调整处理配置后必须更新 manifest');
const missing = path.join(root, 'static', cover.variants.find(item => item.width === 768).src);
await unlink(missing);
assert.deepEqual(await prepareImages(root), first);
assert.equal((await sharp(missing).metadata()).width, 768, '缓存文件丢失后必须重新生成');
await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#2266aa' } }).jpeg().toFile(source);
const third = await prepareImages(root);
assert.notEqual(third['static/images/cover.jpg'].fingerprint, cover.fingerprint, '替换图片必须使缓存失效');
assert.notEqual(third['static/images/cover.jpg'].blurhash, cover.blurhash);
await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#4288bb' } })
  .jpeg().withMetadata({ orientation: 6 }).toFile(path.join(root, 'static/images/rotated.jpg'));
const frames = Buffer.concat([Buffer.alloc(80 * 40 * 3, 32), Buffer.alloc(80 * 40 * 3, 224)]);
for (const format of ['gif', 'webp']) {
  await sharp(frames, { raw: { width: 80, height: 80, channels: 3, pageHeight: 40 } })
    .toFormat(format, { delay: [100, 200], loop: 0 }).toFile(path.join(root, `static/images/animated.${format}`));
}
const formats = await prepareImages(root);
const rotated = formats['static/images/rotated.jpg'];
assert.equal(rotated.width, 800);
assert.equal(rotated.height, 1200);
assert.deepEqual(rotated.variants.map(item => item.width), [320, 480, 640, 768, 800]);
for (const variant of rotated.variants) {
  const metadata = await sharp(path.join(root, 'static', variant.src)).metadata();
  assert.equal(metadata.width, variant.width);
  assert.equal(metadata.height, variant.width * 1.5, 'EXIF 旋转后仍应保留比例');
}
for (const format of ['gif', 'webp']) {
  const animated = formats[`static/images/animated.${format}`];
  assert.equal(animated.height, 40, '动图尺寸应使用单帧高度');
  const metadata = await sharp(path.join(root, 'static', animated.variants[0].src), { animated: true }).metadata();
  assert.equal(metadata.pages, 2, '压缩不能丢失动画帧');
  assert.equal(metadata.pageHeight, 40);
  assert.deepEqual(metadata.delay, [100, 200], '压缩不能改变动画速度');
}
console.log(`图片流水线检查通过：响应式档位、比例、旋转、动图、无扩展名、小图、重复文件、缓存迁移/恢复及内容更新。产物：${root}`);
