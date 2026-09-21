import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, stat, unlink, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { isBlurhashValid } from 'blurhash';
import { prepareImages } from './prepare-images.mjs';
import { installDependencies } from './vercel-install.mjs';

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

// Workers Builds 不依赖平台是否保存自定义 npm 内容；全新工作区从上一版公开的不可变资源恢复。
const publicIndex = JSON.parse(await readFile(path.join(root, 'static/xeu-images/image-cache-v3.json'), 'utf8'));
assert.equal(publicIndex.schemaVersion, 1);
const uniqueFormatCount = new Set(Object.values(formats).map(entry => entry.fingerprint)).size;
assert.equal(Object.keys(publicIndex.entries).length, uniqueFormatCount, '公开索引应按唯一内容保存');
assert.equal(publicIndex.bundle.src, 'xeu-images/image-cache-v3.bin');
assert.equal((await stat(path.join(root, 'static', publicIndex.bundle.src))).size, publicIndex.bundle.size);
const remoteOrigin = 'https://image-cache.example/';
const remoteRequests = [];
const remoteFetch = async input => {
  const url = new URL(input);
  remoteRequests.push(url.pathname);
  if (url.origin !== new URL(remoteOrigin).origin) return new Response('', { status: 404 });
  try {
    const data = await readFile(path.join(root, 'static', decodeURIComponent(url.pathname).replace(/^\//, '')));
    return new Response(data, { status: 200, headers: { 'content-length': String(data.length) } });
  } catch (error) {
    if (error.code === 'ENOENT') return new Response('', { status: 404 });
    throw error;
  }
};
const workerDeploy = await mkdtemp(path.join(tmpdir(), 'xeu-images-worker-deploy-'));
await cp(path.join(root, 'content'), path.join(workerDeploy, 'content'), { recursive: true });
await cp(path.join(root, 'static/images'), path.join(workerDeploy, 'static/images'), { recursive: true });
const workerLogs = [];
assert.deepEqual(await prepareImages(workerDeploy, {
  buildEnv: { WORKERS_CI: '1' },
  cacheOrigin: remoteOrigin,
  fetchImpl: remoteFetch,
  log: line => workerLogs.push(line),
}), formats);
assert.match(workerLogs.at(-1), new RegExp(`缓存复用 6 张.*从构建缓存恢复 6 张.*0 张新生成.*已部署资源缓存索引 ${uniqueFormatCount} 份，远端恢复 6 张`));
assert.ok(remoteRequests.includes('/xeu-images/image-cache-v3.json'));
assert.ok(remoteRequests.includes('/xeu-images/image-cache-v3.bin'));
assert.equal(remoteRequests.length, 2, '远端恢复应只请求索引和单个 bundle');
for (const entry of Object.values(formats)) for (const variant of entry.variants) {
  assert.deepEqual(await readFile(path.join(workerDeploy, 'static', variant.src)), await readFile(path.join(root, 'static', variant.src)), '线上资源恢复的派生图必须逐字节一致');
}

// 模拟新部署：只有 Git 原图与 Vercel 保存的 node_modules 缓存，没有上次的发布产物。
const deployed = await mkdtemp(path.join(tmpdir(), 'xeu-images-deploy-'));
const cacheRelative = 'node_modules/.cache/xeu-images';
const cache = path.join(deployed, cacheRelative);
await cp(path.join(root, 'content'), path.join(deployed, 'content'), { recursive: true });
await cp(path.join(root, 'static/images'), path.join(deployed, 'static/images'), { recursive: true });
await cp(path.join(root, cacheRelative), cache, { recursive: true });
await writeFile(path.join(deployed, 'package.json'), JSON.stringify({ name: 'image-cache-fixture', version: '1.0.0', private: true }));
await writeFile(path.join(deployed, 'package-lock.json'), JSON.stringify({
  name: 'image-cache-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'image-cache-fixture', version: '1.0.0' } },
}));
await writeFile(path.join(deployed, '.npmrc'), 'audit=false\nfund=false\noffline=true\n');
const savedManifest = await readFile(path.join(cache, 'images.json'), 'utf8');
await writeFile(path.join(deployed, 'node_modules/discard-me'), 'npm ci should remove this');
await installDependencies(deployed);
assert.equal(await readFile(path.join(cache, 'images.json'), 'utf8'), savedManifest, 'npm ci 不能清空构建缓存');
await assert.rejects(stat(path.join(deployed, 'node_modules/discard-me')), { code: 'ENOENT' }, '必须实际执行 npm ci');
const restoredLogs = [];
assert.deepEqual(await prepareImages(deployed, { log: line => restoredLogs.push(line) }), formats);
assert.match(restoredLogs.at(-1), /缓存复用 6 张.*从构建缓存恢复 [1-6] 张.*，0 张新生成/);
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

// 删除原图后清理失效缓存，保留其他文件；安装失败也不能丢失上次成功构建的缓存。
await writeFile(path.join(cache, 'files/keep.txt'), 'unrelated');
await unlink(path.join(deployed, 'static/images/renamed.png'));
const removed = await prepareImages(deployed);
assert.equal(removed['static/images/renamed.png'], undefined);
await assert.rejects(stat(smallCache), { code: 'ENOENT' });
assert.equal(await readFile(path.join(cache, 'files/keep.txt'), 'utf8'), 'unrelated');
const beforeFailure = await readFile(path.join(cache, 'images.json'), 'utf8');
await writeFile(path.join(deployed, 'package.json'), JSON.stringify({
  name: 'image-cache-fixture', version: '1.0.0', scripts: { preinstall: 'node -e "process.exit(7)"' },
}));
await assert.rejects(installDependencies(deployed, { log: () => {} }), /执行失败/);
assert.equal(await readFile(path.join(cache, 'images.json'), 'utf8'), beforeFailure);
assert.deepEqual(await readdir(path.join(deployed, '.cache/deploy')), [], '安装暂存目录必须清理');
const coldInstall = await mkdtemp(path.join(tmpdir(), 'xeu-images-install-'));
await writeFile(path.join(coldInstall, 'package.json'), JSON.stringify({ name: 'image-cache-fixture', version: '1.0.0' }));
await copyFile(path.join(deployed, 'package-lock.json'), path.join(coldInstall, 'package-lock.json'));
await copyFile(path.join(deployed, '.npmrc'), path.join(coldInstall, '.npmrc'));
await installDependencies(coldInstall, { log: () => {} });
assert.deepEqual(await readdir(path.join(coldInstall, '.cache/deploy')), [], '首次无缓存安装必须成功');
console.log(`图片流水线检查通过：小图/中图/原图三档、比例、旋转、动图、无扩展名、同内容复用、线上已部署资源恢复、Vercel 跨构建缓存、npm ci 保留/失败恢复、缓存修复/清理及内容更新。产物：${root}；模拟部署：${deployed}`);
