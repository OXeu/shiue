import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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
    assert.equal(url.searchParams.get('v'), '4');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['s', 'v']);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['cache-control'], 'no-cache');
    requests.push(href);
    return response(png);
  };
  const first = await prepareIdentity({ root, fetchImpl, log });
  assert.deepEqual(first.avatars.map(avatar => avatar.size), AVATAR_SIZES);
  assert.ok(first.favicons.every(asset => asset.src.endsWith('.webp')), '浏览器 favicon 应使用 WebP');
  assert.ok(first.touchIcon.src.endsWith('.webp'), '192px 浏览器图标应使用 WebP');
  assert.ok(first.appleTouchIcon.src.endsWith('.png'), 'Apple Touch Icon 应保留 PNG');
  assert.ok(first.socialImage.src.endsWith('.png'), '默认分享图应保留 PNG');
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
  assert.equal(requests[0], requests[1], '每次都重新请求标准头像地址，不附加随机查询参数');
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

test('an HTTP 200 GitHub placeholder retries the canonical user avatar before generating icons', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-identity-placeholder-'));
  const placeholder = Buffer.from(await readFile(new URL('./fixtures/github-avatar-placeholder.base64', import.meta.url), 'utf8'), 'base64');
  const png = await picture('#d61c59');
  const requests = [];
  const logs = [];
  const manifest = await prepareIdentity({ root, log: message => logs.push(message), fetchImpl: async (href, options) => {
    requests.push(href);
    assert.equal(options.cache, 'no-store');
    return response(requests.length === 1 ? placeholder : png);
  } });
  assert.deepEqual(requests, [`${AVATAR_SOURCE}?v=4&s=512`, `${AVATAR_SOURCE}?v=4`]);
  assert.ok(logs.some(message => message.includes('默认占位图')));
  const actual = await sharp(path.join(root, 'static', manifest.socialImage.src)).raw().toBuffer();
  const expected = await sharp(png).resize(512, 512, { fit: 'cover' }).raw().toBuffer();
  assert.deepEqual(actual, expected, '图标必须来自重试取得的用户头像');

  const previousManifest = await readFile(path.join(root, 'data/xeu/identity.json'), 'utf8');
  const previousICO = await readFile(path.join(root, 'static/favicon.ico'));
  const previousAvatar = await readFile(path.join(root, 'static/avatar.jpg'));
  const previousFiles = await readdir(path.join(root, 'static/site-identity'));
  let attempts = 0;
  await assert.rejects(prepareIdentity({ root, log, fetchImpl: async () => { attempts++; return response(placeholder); } }), /不使用旧缓存.*默认占位图/);
  assert.equal(attempts, 2);
  assert.equal(await readFile(path.join(root, 'data/xeu/identity.json'), 'utf8'), previousManifest);
  assert.deepEqual(await readFile(path.join(root, 'static/favicon.ico')), previousICO);
  assert.deepEqual(await readFile(path.join(root, 'static/avatar.jpg')), previousAvatar);
  assert.deepEqual(await readdir(path.join(root, 'static/site-identity')), previousFiles);
});

test('offline mode rejects assets generated before placeholder validation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-identity-legacy-'));
  const manifest = await prepareIdentity({ root, fetchImpl: async () => response(await picture('#333')), log });
  manifest.recipe = JSON.stringify({ ...JSON.parse(manifest.recipe), version: 1 });
  await writeFile(path.join(root, 'data/xeu/identity.json'), JSON.stringify(manifest));
  await assert.rejects(readIdentity(root), /需要重新生成/);
  await assert.rejects(prepareIdentity({ root, offline: true, fetchImpl: () => assert.fail('离线模式不能访问外网'), log }), /先联网运行 npm run identity/);
});
