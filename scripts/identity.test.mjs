import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AVATAR_SOURCE, AVATAR_SIZES, ICON_SIZES, prepareIdentity, readIdentity, identityAssets } from './deploy/identity.mjs';
import { prepareImages } from './prepare-images.mjs';

const log = () => {};
const picture = background => sharp({ create: { width: 640, height: 480, channels: 4, background } }).png().toBuffer();
const response = bytes => new Response(bytes, { headers: { 'content-type': 'image/png' } });

test('identity fetches on every invocation, generates exact sizes, and never stores the original', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-identity-test-'));
  const png = await picture('#d61c59');
  const requests = [];
  const fetchImpl = async (href, options) => {
    const url = new URL(href);
    assert.equal(`${url.origin}${url.pathname}`, AVATAR_SOURCE);
    assert.equal(url.searchParams.get('s'), '512');
    assert.ok(url.searchParams.get('_deploy'));
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['cache-control'], 'no-cache');
    requests.push(href);
    return response(png);
  };
  const first = await prepareIdentity({ root, fetchImpl, log });
  assert.deepEqual(first.avatars.map(avatar => avatar.size), AVATAR_SIZES);
  for (const asset of identityAssets(first).filter(asset => asset.size)) {
    const bytes = await readFile(path.join(root, 'static', asset.src));
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, asset.size);
    assert.equal(metadata.height, asset.size);
    assert.equal(metadata.format, asset.src.endsWith('.webp') ? 'webp' : 'png');
    assert.ok(!bytes.equals(png), '原始下载文件不能写入构建目录');
  }
  const ico = await readFile(path.join(root, 'static', first.ico.src));
  assert.equal(ico.readUInt32LE(0), 0x00010000);
  assert.equal(ico.readUInt16LE(4), 3);
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size);
    assert.equal(ico[entry + 1], size);
    const start = ico.readUInt32LE(entry + 12);
    const length = ico.readUInt32LE(entry + 8);
    assert.equal((await sharp(ico.subarray(start, start + length)).metadata()).width, size);
  }
  assert.deepEqual(await readFile(path.join(root, 'static/favicon.ico')), ico);
  const jpeg = await sharp(path.join(root, 'static/avatar.jpg')).metadata();
  assert.equal(jpeg.format, 'jpeg');
  assert.equal(jpeg.width, 512);
  assert.deepEqual(await readIdentity(root), first);
  const second = await prepareIdentity({ root, fetchImpl, log });
  assert.equal(requests.length, 2, '即使已有产物也必须重新请求 GitHub');
  assert.notEqual(requests[0], requests[1], '每次请求应带独立的缓存破坏参数');
  assert.equal(second.fingerprint, first.fingerprint, '内容未变化可保留相同的浏览器资源地址');
  const changed = await prepareIdentity({ root, fetchImpl: async () => response(await picture('#2266aa')), log });
  assert.notEqual(changed.fingerprint, first.fingerprint, '头像变化必须更新浏览器资源地址');
  assert.deepEqual(await readIdentity(root), changed);
  const files = await readdir(path.join(root, 'static'), { recursive: true });
  assert.ok(!files.some(file => /original|source|download/.test(file)));
  assert.equal(identityAssets(changed).length, AVATAR_SIZES.length + ICON_SIZES.length + 1);
  const images = await prepareImages(root, { log });
  assert.deepEqual(images, {}, '通用图片流水线不能重复处理已生成的站点图标');
});

test('only explicit offline mode may reuse generated assets; missing assets fail clearly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-identity-offline-'));
  await assert.rejects(prepareIdentity({ root, offline: true, log }), /先联网运行 npm run identity/);
  const manifest = await prepareIdentity({ root, fetchImpl: async () => response(await picture('#333')), log });
  const cached = await prepareIdentity({ root, offline: true, fetchImpl: () => assert.fail('离线模式不能访问外网'), log });
  assert.deepEqual(cached, manifest);
  await unlink(path.join(root, 'static', manifest.favicons[0].src));
  await assert.rejects(prepareIdentity({ root, offline: true, log }), /缺失或无效/);
});

test('download failures cannot silently reuse old assets or replace the manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-identity-failure-'));
  await prepareIdentity({ root, fetchImpl: async () => response(await picture('#333')), log });
  const file = path.join(root, 'data/xeu/identity.json');
  const previous = await readFile(file, 'utf8');
  let attempts = 0;
  await assert.rejects(prepareIdentity({ root, log, fetchImpl: async () => { attempts++; return new Response('', { status: 503 }); } }), /不使用旧缓存/);
  assert.equal(attempts, 2);
  await assert.rejects(prepareIdentity({ root, log, fetchImpl: async () => new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } }) }), /不是图片/);
  await assert.rejects(prepareIdentity({ root, log, fetchImpl: async () => response(Buffer.from('not a real image')) }));
  await assert.rejects(prepareIdentity({ root, log, fetchImpl: async () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': 6 * 1024 * 1024 } }) }), /超过 5MB/);
  assert.equal(await readFile(file, 'utf8'), previous);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareIdentity({ root, signal: controller.signal, fetchImpl: () => assert.fail(), log }));
  assert.equal(await readFile(file, 'utf8'), previous);
});
