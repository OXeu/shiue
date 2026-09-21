import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { addFriend, pageMetadata, websiteKey, websiteURL } from './add-friend.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(tmpdir(), 'xeu-friends-test-'));
const png = await sharp({ create: { width: 512, height: 256, channels: 4, background: '#d61c59' } }).png().toBuffer();
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
png.copy(ico, 22);
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/blog/' }).end();
  } else if (req.url === '/blog/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<base href="/assets/"><title>页面标题</title>
      <meta content="中文 &amp; Blog" property="og:site_name">
      <meta name="description" content=" 慢慢记录 &amp; 分享 ">
      <link href="invalid.png" rel="ICON" sizes="any">
      <link sizes="180x180" href="icon.png?size=180&amp;fit=1" rel="apple-touch-icon">
      <link rel="icon" href="data:image/png;base64,invalid">
      <script>const example = '<link rel="icon" href="evil.png">';</script>`);
  } else if (req.url.startsWith('/assets/icon.png') || req.url === '/manual.png') {
    res.setHeader('content-type', 'image/png');
    res.end(png);
  } else if (req.url === '/favicon.ico') {
    res.setHeader('content-type', 'image/x-icon');
    res.end(ico);
  } else if (req.url === '/vector.svg') {
    res.setHeader('content-type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="pink"/></svg>');
  } else if (req.url === '/too-big.png') {
    res.setHeader('content-length', 6 * 1024 * 1024);
    res.end();
  } else if (req.url === '/too-big-stream.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.alloc(6 * 1024 * 1024));
  } else if (req.url === '/broken.ico') {
    res.end(Buffer.from([0, 0, 1, 0, 1, 0]));
  } else if (req.url === '/assets/invalid.png') {
    res.setHeader('content-type', 'image/png');
    res.end('<html>不是图标</html>');
  } else if (req.url === '/redirect-existing') {
    res.writeHead(302, { location: '/manual' }).end();
  } else if (req.url === '/empty-site') {
    res.setHeader('content-type', 'text/html');
    res.end('<title>只提供 favicon 的站点</title>');
  } else if (req.url === '/manual') {
    res.setHeader('content-type', 'text/html');
    res.end('<title>已添加的站点</title>');
  } else {
    res.writeHead(404).end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const root = path.join(fixture, 'repository');
const readData = async () => JSON.parse(await readFile(path.join(root, 'data/friends.json'), 'utf8'));
const snapshot = async () => ({
  json: await readFile(path.join(root, 'data/friends.json'), 'utf8'),
  files: (await readdir(path.join(root, 'static/friends'))).sort(),
});
const opts = { root, warn: () => {} };
try {
  const friend = await addFriend({ website: `${base}/redirect` }, opts);
  assert.equal(friend.title, '中文 & Blog');
  assert.equal(friend.description, '慢慢记录 & 分享');
  assert.equal(friend.iconSource, `${base}/assets/icon.png?size=180&fit=1`);
  assert.ok(requests.includes('/assets/invalid.png'), '高优先级无效图标应回退到下一个');
  assert.ok(!requests.includes('/assets/evil.png'), '不应解析 script 内的假标签');
  const metadata = await sharp(path.join(root, 'static', friend.image)).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 64);
  assert.equal(websiteKey(`${base}/blog/#top`), websiteKey(`${base}/blog`));
  assert.equal(websiteKey('https://example.org/'), websiteKey('http://example.org'));
  assert.throws(() => websiteURL('file:///etc/passwd'), /HTTP/);
  assert.throws(() => websiteURL('https://user:pass@example.com'), /HTTP/);

  const before = await snapshot();
  await assert.rejects(addFriend({ website: `${base}/redirect/#top` }, opts), /已存在/);
  for (const icon of ['/missing.png', '/assets/invalid.png', '/too-big.png', '/too-big-stream.png', '/broken.ico']) {
    await assert.rejects(addFriend({ website: `${base}/failure`, title: '无效图标', description: '', icon }, opts), /没有下载到有效图标/);
    assert.deepEqual(await snapshot(), before, '失败后数据和图片目录必须保持不变');
  }
  await assert.rejects(addFriend({ website: base, title: '', icon: '/manual.png' }, opts), /名称不能为空/);
  await assert.rejects(addFriend({ website: base, icon: 'javascript:alert(1)' }, opts), /HTTP/);

  const countBefore = requests.length;
  const manual = await addFriend({ website: `${base}/manual`, title: '手工名称', description: '', icon: '/manual.png' }, opts);
  assert.equal(manual.title, '手工名称');
  assert.equal(manual.description, '');
  assert.deepEqual(requests.slice(countBefore), ['/manual.png'], '全部指定时无需访问首页');
  await assert.rejects(addFriend({ website: `${base}/redirect-existing` }, opts), /跳转后的站点已存在/);

  const fallback = await addFriend({ website: `${base}/empty-site` }, opts);
  assert.ok(fallback.image.endsWith('.ico'));
  assert.deepEqual(await readFile(path.join(root, 'static', fallback.image)), ico);
  const warnings = [];
  const unavailable = await addFriend({ website: `${base}/unavailable` }, { root, warn: message => warnings.push(message) });
  assert.equal(unavailable.title, '127.0.0.1');
  assert.equal(warnings.length, 1);
  const vector = await addFriend({ website: `${base}/vector`, title: 'SVG', description: '矢量图标', icon: '/vector.svg' }, opts);
  assert.equal((await sharp(path.join(root, 'static', vector.image)).metadata()).width, 64, '小图不得放大，SVG 应光栅化');

  const concurrent = await Promise.allSettled([
    addFriend({ website: `${base}/concurrent`, title: '并发', description: '', icon: '/manual.png' }, opts),
    addFriend({ website: `${base}/concurrent`, title: '并发', description: '', icon: '/manual.png' }, opts),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await readData()).filter(item => item.website === `${base}/concurrent`).length, 1);
  assert.deepEqual((await readdir(path.join(root, 'data'))), ['friends.json'], '锁和临时文件应被清理');

  const utf8 = pageMetadata(Buffer.from('<title>没有 charset 的中文博客</title><link rel="icon" href="//example.org/i.png">'), base);
  assert.equal(utf8.title, '没有 charset 的中文博客');
  assert.equal(utf8.icons[0], 'http://example.org/i.png');
  const latin1 = pageMetadata(Buffer.from('<title>Caf\xe9</title>', 'latin1'), base, 'text/html; charset=iso-8859-1');
  assert.equal(latin1.title, 'Café', 'HTTP charset 应使用新版 encoding-sniffer 正确解码');

  // Exercise the actual CLI against an isolated repo, not the real friend list.
  await mkdir(path.join(root, 'scripts'));
  await copyFile(path.join(repo, 'scripts/add-friend.mjs'), path.join(root, 'scripts/add-friend.mjs'));
  await symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const cli = async args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/add-friend.mjs'), ...args], { cwd: fixture });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  assert.equal((await cli(['--help'])).code, 0);
  assert.equal((await cli([])).code, 1);
  assert.equal((await cli([base, '--unknown'])).code, 1);
  const added = await cli([`${base}/cli`, '--title', 'CLI 朋友', '--description', '命令行添加', '--icon', '/manual.png']);
  assert.equal(added.code, 0, added.output);
  assert.match(added.output, /已添加：CLI 朋友/);
  assert.equal((await readData()).at(-1).title, 'CLI 朋友');
  assert.equal((await cli([`${base}/cli`])).code, 1, 'CLI 重复网址应返回非零状态');

  // Verify committed data without depending on any external site during CI.
  const friends = JSON.parse(await readFile(path.join(repo, 'data/friends.json'), 'utf8'));
  assert.equal(new Set(friends.map(friend => websiteKey(friend.website))).size, friends.length);
  for (const item of friends) {
    assert.ok(item.title && typeof item.description === 'string' && typeof item.health === 'string');
    websiteURL(item.website);
    assert.match(item.image, /^\/friends\/[a-z0-9.-]+\.(webp|ico)$/);
    const bytes = await readFile(path.join(repo, 'static', item.image));
    assert.ok(bytes.length > 0);
    if (item.image.endsWith('.webp')) {
      const image = await sharp(bytes).metadata();
      assert.ok(image.width <= 128 && image.height <= 128);
    }
  }
  console.log(`友链检查通过：${friends.length} 条本地数据；自动发现、重定向、图标回退、ICO/SVG、重复检测、失败回滚、并发锁及 CLI。产物：${fixture}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
