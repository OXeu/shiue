import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, stat, unlink, rename } from 'node:fs/promises';
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
const originalBytes = await readFile(source);
await copyFile(source, path.join(root, 'content/post/example/extensionless'));
await writeFile(path.join(root, 'content/post/example/README'), '不是图片');
await sharp({ create: { width: 40, height: 20, channels: 4, background: '#4288bb' } }).png().toFile(path.join(root, 'static/images/small.png'));

const first = await prepareImages(root);
assert.deepEqual(await readFile(source), originalBytes, '原图必须逐字节保持不变');
assert.equal(Object.keys(first).length, 3);
const cover = first['static/images/cover.jpg'];
assert.ok(isBlurhashValid(cover.blurhash).result);
assert.deepEqual(cover.variants.map(item => [item.role, item.width]), [['thumbnail', 640], ['medium', 1600]]);
assert.deepEqual(first['content/post/example/extensionless'], cover, '无扩展名和重复图片应生成相同结果');
const smallEntry = first['static/images/small.png'];
assert.deepEqual(smallEntry.variants.map(item => [item.role, item.width]), [['thumbnail', 40], ['medium', 40]], '小图不得放大');
assert.equal(smallEntry.variants[0].src, smallEntry.variants[1].src, '小原图的两种角色应复用同一派生文件');
for (const variant of new Map(cover.variants.map(item => [item.src, item])).values()) {
  const metadata = await sharp(path.join(root, 'static', variant.src)).metadata();
  assert.equal(metadata.width, variant.width, '图片档位宽度必须与实际文件一致');
  assert.equal(metadata.height, Math.round(variant.width * 2 / 3), '派生图片应保留原始比例');
}
const before = await stat(path.join(root, 'static', cover.variants[0].src));
const manifestBefore = await readFile(path.join(root, 'data/xeu/images.json'), 'utf8');
const warmLogs = [];
const second = await prepareImages(root, { log: line => warmLogs.push(line) });
assert.deepEqual(second, first);
assert.match(warmLogs.at(-1), /缓存复用 3 张.*，0 张新生成/);
assert.equal((await stat(path.join(root, 'static', cover.variants[0].src))).mtimeMs, before.mtimeMs, '缓存命中不应重写图片');
assert.equal(await readFile(path.join(root, 'data/xeu/images.json'), 'utf8'), manifestBefore);
// 旧配置缓存不能跳过角色或新增档位；磁盘上缺少任何档位时必须恢复。
await writeFile(path.join(root, 'data/xeu/images.json'), JSON.stringify({
  ...first, 'static/images/cover.jpg': { ...cover, fingerprint: 'old-recipe', variants: cover.variants.filter(item => item.role !== 'medium') },
}));
assert.deepEqual(await prepareImages(root), first, '调整处理配置后必须更新 manifest');
const missing = path.join(root, 'static', cover.variants.find(item => item.role === 'medium').src);
await unlink(missing);
assert.deepEqual(await prepareImages(root), first);
assert.equal((await sharp(missing).metadata()).width, 1600, '发布文件丢失后必须从缓存恢复');
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
assert.deepEqual(rotated.variants.map(item => [item.role, item.width]), [['thumbnail', 640], ['medium', 800]]);
for (const variant of new Map(rotated.variants.map(item => [item.src, item])).values()) {
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

// 旧的远端缓存索引和 bundle 必须停止发布。
for (const name of ['image-cache-v3.json', 'image-cache-v3.bin']) {
  const legacy = path.join(root, 'static/xeu-images', name);
  await writeFile(legacy, 'legacy');
  await prepareImages(root);
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
}

// 模拟 Workers Builds 新工作区：只有 Git 原图与平台恢复的 $PWD/.cache/xeu-images。
const deployed = await mkdtemp(path.join(tmpdir(), 'xeu-images-deploy-'));
const cacheRelative = '.cache/xeu-images';
const cache = path.join(deployed, cacheRelative);
await cp(path.join(root, 'content'), path.join(deployed, 'content'), { recursive: true });
await cp(path.join(root, 'static/images'), path.join(deployed, 'static/images'), { recursive: true });
await cp(path.join(root, cacheRelative), cache, { recursive: true });
const restoredLogs = [];
assert.deepEqual(await prepareImages(deployed, { buildEnv: { WORKERS_CI: '1' }, log: line => restoredLogs.push(line) }), formats);
assert.match(restoredLogs.at(-1), /缓存复用 6 张.*从构建缓存恢复 6 张.*，0 张新生成/);
for (const entry of Object.values(formats)) {
  for (const variant of entry.variants) {
    assert.deepEqual(await readFile(path.join(deployed, 'static', variant.src)), await readFile(path.join(root, 'static', variant.src)), '恢复的缩略图必须逐字节一致');
  }
}

// 源文件重命名仍可按内容复用；缓存文件缺失或损坏只补算受影响图片。
await rename(path.join(deployed, 'static/images/small.png'), path.join(deployed, 'static/images/renamed.png'));
const renamedLogs = [];
const renamed = await prepareImages(deployed, { log: line => renamedLogs.push(line) });
assert.equal(renamed['static/images/small.png'], undefined);
assert.deepEqual(renamed['static/images/renamed.png'], formats['static/images/small.png']);
assert.match(renamedLogs.at(-1), /，0 张新生成/);
const small = renamed['static/images/renamed.png'];
const smallOutput = path.join(deployed, 'static', small.variants[0].src);
const smallCache = path.join(cache, 'files', path.basename(small.variants[0].src));
await unlink(smallOutput);
await writeFile(smallCache, '');
const partialLogs = [];
assert.deepEqual(await prepareImages(deployed, { log: line => partialLogs.push(line) }), renamed);
assert.match(partialLogs.at(-1), /缓存复用 5 张.*，1 张新生成/);
assert.deepEqual(await readFile(smallCache), await readFile(smallOutput));

// 旧处理配置与不完整的索引不能误命中；非法 JSON 自动按冷缓存处理。
for (const stale of [{ ...small, fingerprint: 'old-recipe' }, { ...small, variants: [] }, { ...small, blurhash: 'invalid' }]) {
  const broken = { ...renamed, 'static/images/renamed.png': stale };
  for (const file of ['data/xeu/images.json', `${cacheRelative}/images.json`]) await writeFile(path.join(deployed, file), JSON.stringify(broken));
  const logs = [];
  assert.deepEqual(await prepareImages(deployed, { log: line => logs.push(line) }), renamed);
  assert.match(logs.at(-1), /缓存复用 5 张.*，1 张新生成/);
}
for (const file of ['data/xeu/images.json', `${cacheRelative}/images.json`]) await writeFile(path.join(deployed, file), '{invalid');
assert.deepEqual(await prepareImages(deployed), renamed);

// 删除原图后清理失效缓存，同时保留缓存目录中的其他文件。
await writeFile(path.join(cache, 'files/keep.txt'), 'unrelated');
await unlink(path.join(deployed, 'static/images/renamed.png'));
const removed = await prepareImages(deployed);
assert.equal(removed['static/images/renamed.png'], undefined);
await assert.rejects(stat(smallCache), { code: 'ENOENT' });
assert.equal(await readFile(path.join(cache, 'files/keep.txt'), 'utf8'), 'unrelated');
console.log(`图片流水线检查通过：小图/中图/原图三档、比例、旋转、动图、无扩展名、同内容复用、Workers .cache 跨构建恢复、缓存修复/清理及内容更新。产物：${root}；模拟部署：${deployed}`);
