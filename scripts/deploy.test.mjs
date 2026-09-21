import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runPipeline } from './deploy/pipeline.mjs';
import { Reporter, duration } from './deploy/reporter.mjs';
import { command } from './deploy/process.mjs';
import { probeFriend, updateFriendHealth } from './deploy/friends.mjs';
import { deploymentSteps } from './deploy/steps.mjs';
import { parseOptions } from './deploy.mjs';
import { cacheProbeEnabled, captureBuildCaches, formatBuildCacheDelta, formatBuildCacheProbe, formatBuildCacheSnapshot, placeBuildCacheProbe } from './deploy/cache-probe.mjs';

function output() {
  let text = '';
  return { get text() { return text; }, write(value) { text += value; }, isTTY: false };
}

test('build cache probe reports Cloudflare candidates before and after without following links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-cache-probe-root-'));
  const home = await mkdtemp(path.join(tmpdir(), 'xeu-cache-probe-home-'));
  await mkdir(path.join(home, '.npm/_cacache/content-v2'), { recursive: true });
  await writeFile(path.join(home, '.npm/_cacache/content-v2/item'), '1234');
  await symlink(home, path.join(home, '.npm/_cacache/recursive-link'));
  await mkdir(path.join(root, 'node_modules/.cache/framework/files'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/.cache/framework/files/item.bin'), '123456');
  const before = await captureBuildCaches({ root, env: { HOME: home } });
  const npm = before.snapshots.find(item => item.label === 'npm 全局缓存');
  const images = before.snapshots.find(item => item.path === path.join(root, 'node_modules/.cache'));
  assert.equal(npm.counts.files, 1);
  assert.equal(npm.counts.bytes, 4);
  assert.equal(npm.counts.links, 1);
  assert.deepEqual(npm.entries.map(entry => entry.name), ['_cacache']);
  assert.equal(images.counts.files, 1);
  assert.equal(images.counts.bytes, 6);
  assert.match(formatBuildCacheSnapshot(before, '构建前'), /\[目录\] _cacache · 1 个文件/);
  await writeFile(path.join(root, 'node_modules/.cache/framework/files/second.bin'), '12');
  const after = await captureBuildCaches({ root, env: { HOME: home } });
  assert.match(formatBuildCacheDelta(before, after), /Docusaurus \/ 通用 node_modules 缓存：文件 \+1 · 目录 \+0 · 大小 \+2 B/);
  assert.equal(cacheProbeEnabled({ WORKERS_CI: '1' }), true);
  assert.equal(cacheProbeEnabled({ WORKERS_CI: '1', SHIUE_CACHE_PROBE: '0' }), false);
  assert.equal(cacheProbeEnabled({ SHIUE_CACHE_PROBE: '1' }), true);
});

test('build cache probe places one unique marker directly under $PWD/.cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-cache-marker-'));
  const firstId = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  const first = await placeBuildCacheProbe({ root, env: { WORKERS_CI: '1' }, id: firstId, now: new Date('2026-09-21T00:00:00.000Z') });
  assert.equal(JSON.parse(await readFile(first.file, 'utf8')).environment, 'cloudflare-workers-builds');
  assert.match(formatBuildCacheProbe(first), new RegExp(firstId));
  const second = await placeBuildCacheProbe({ root, env: {}, id: secondId, now: new Date('2026-09-21T00:01:00.000Z') });
  const names = await readdir(path.join(root, '.cache'));
  assert.deepEqual(names, [`cloudflare-build-probe-${secondId}.json`]);
  assert.equal(JSON.parse(await readFile(second.file, 'utf8')).environment, 'manual');
  const snapshot = await captureBuildCaches({ root, env: { HOME: path.join(root, 'home') } });
  const projectCache = snapshot.snapshots.find(item => item.path === path.join(root, '.cache'));
  assert.deepEqual(projectCache.entries.map(entry => entry.name), names);
  await assert.rejects(placeBuildCacheProbe({ root, id: '../outside' }), /UUID/);
});

test('pipeline records timing, warnings, skips, and an atomic JSON report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-pipeline-'));
  const stream = output();
  const context = {};
  const report = await runPipeline({
    context, reporter: new Reporter(stream), reportPath: path.join(root, 'report.json'),
    steps: [
      { id: 'one', title: '第一步', run: async (ctx, io) => { io.log('progress'); await delay(12); ctx.ready = true; return { count: 2 }; } },
      { id: 'two', title: '第二步', run: (ctx, io) => { assert.ok(ctx.ready); io.warn('友链暂时不可用'); } },
      { id: 'three', title: '第三步', skip: () => '离线', run: () => assert.fail('应跳过') },
    ],
  });
  assert.deepEqual(report.steps.map(step => step.status), ['success', 'warning', 'skipped']);
  assert.equal(report.status, 'success');
  assert.ok(report.steps[0].durationMs >= 5);
  assert.ok(report.durationMs >= report.steps[0].durationMs);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8')), report);
  assert.match(stream.text, /\[1\/3\]/);
  assert.match(stream.text, /总耗时/);
  assert.match(stream.text, /最耗时/);
  assert.doesNotMatch(stream.text, /\x1b/);
});

test('pipeline fails fast and still writes the failed step and skipped dependents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-pipeline-failure-'));
  const stream = output();
  await assert.rejects(runPipeline({
    reporter: new Reporter(stream), reportPath: path.join(root, 'report.json'),
    steps: [
      { id: 'fail', title: '会失败', run: () => { throw new Error('example failure'); } },
      { id: 'later', title: '不应运行', run: () => assert.fail() },
    ],
  }), /未完成/);
  const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.steps.map(step => step.status), ['failed', 'skipped']);
  assert.equal(report.steps[0].error, 'example failure');
  assert.match(stream.text, /不应发布/);
});

test('cancellation stops dependent steps and command processes', async () => {
  const controller = new AbortController();
  await assert.rejects(runPipeline({
    reporter: new Reporter(output()), signal: controller.signal,
    steps: [
      { id: 'cancel', title: '取消', run: () => controller.abort(new Error('stop')) },
      { id: 'later', title: '不应运行', run: () => assert.fail() },
    ],
  }), error => error.report.status === 'cancelled' && error.report.steps[1].status === 'skipped');
  const childController = new AbortController();
  const pending = command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: childController.signal });
  setTimeout(() => childController.abort(), 30);
  await assert.rejects(pending);
});

test('command streams output, captures resolver output and propagates failures', async () => {
  const logs = [];
  const result = await command(process.execPath, ['-e', 'console.log("binary-path"); console.error("diagnostic")'], { capture: true, log: line => logs.push(line) });
  assert.equal(result, 'binary-path');
  assert.deepEqual(logs, ['diagnostic']);
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(7)']), /退出码 7/);
  await assert.rejects(command('/definitely-not-a-program', []), /ENOENT/);
});

test('reporter supports readable CI logs, opt-out color and elapsed formatting', () => {
  const stream = output();
  stream.isTTY = true;
  const reporter = new Reporter(stream, { NO_COLOR: '1', CI: '1' });
  reporter.start('CLI', []);
  reporter.log('untrusted\x1b[31m name\x07');
  reporter.finish({ status: 'failed', durationMs: 61_500, steps: [] });
  assert.doesNotMatch(stream.text, /\x1b|\x07/);
  assert.equal(duration(20), '20ms');
  assert.equal(duration(1510), '1.51s');
  assert.equal(duration(61500), '1m 1.5s');
});

test('health probe handles GET, redirects, 403, retries, timeouts, loops and TLS errors', async () => {
  let failures = 0;
  let head = 0;
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') head++;
    if (req.url === '/ok') res.writeHead(200).end('OK');
    else if (req.url === '/redirect') res.writeHead(302, { location: '/ok' }).end();
    else if (req.url === '/denied') res.writeHead(403).end();
    else if (req.url === '/retry') res.writeHead(++failures === 1 ? 503 : 200).end();
    else if (req.url === '/loop') res.writeHead(302, { location: '/loop' }).end();
    else if (req.url === '/slow') { /* response intentionally never completes */ }
    else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await probeFriend(`${base}/ok`)).health, '');
    const redirected = await probeFriend(`${base}/redirect`);
    assert.equal(redirected.health, '');
    assert.equal(redirected.finalURL, `${base}/ok`);
    const denied = await probeFriend(`${base}/denied`);
    assert.equal(denied.health, '访问受限（HTTP 403）');
    assert.equal(denied.attempts, 1);
    const retried = await probeFriend(`${base}/retry`, { retryDelayMs: 1 });
    assert.equal(retried.health, '');
    assert.equal(retried.attempts, 2);
    assert.equal((await probeFriend(`${base}/slow`, { timeoutMs: 20, retries: 0 })).health, '连接超时');
    assert.equal((await probeFriend(`${base}/loop`)).health, '重定向过多');
    assert.equal((await probeFriend(`${base}/missing`)).health, 'HTTP 404');
    assert.equal(head, 0);
    const tls = await probeFriend('https://invalid.example/', { retries: 0, fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }); } });
    assert.equal(tls.health, '证书已过期');
    await assert.rejects(probeFriend('file:///tmp/a'), /HTTP/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('health snapshot is separate from friend data and bounds concurrency', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-health-'));
  await mkdir(path.join(root, 'data'));
  const friends = Array.from({ length: 7 }, (_, index) => ({ title: `朋友 ${index}`, website: `https://example.org/${index}`, health: '旧状态' }));
  const original = JSON.stringify(friends);
  await writeFile(path.join(root, 'data/friends.json'), original);
  let running = 0;
  let maxRunning = 0;
  const warnings = [];
  const fetchImpl = async url => {
    maxRunning = Math.max(maxRunning, ++running);
    await delay(5);
    running--;
    return new Response('', { status: url.endsWith('/6') ? 404 : 200 });
  };
  await updateFriendHealth({ root, concurrency: 2, fetchImpl, log: () => {}, warn: value => warnings.push(value) });
  assert.equal(maxRunning, 2);
  assert.equal(await readFile(path.join(root, 'data/friends.json'), 'utf8'), original);
  const file = path.join(root, 'data/xeu/friend-health.json');
  const report = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(report.sites[friends[0].website].health, '', '恢复正常必须清除旧状态');
  assert.equal(report.sites[friends[6].website].health, 'HTTP 404');
  assert.ok(report.checkedAt);
  assert.equal(warnings.length, 1);
  const previous = await readFile(file, 'utf8');
  const result = await updateFriendHealth({ root, retries: 0, fetchImpl: async () => { throw new Error('network down'); }, log: () => {}, warn: () => {} });
  assert.equal(result.preserved, true);
  assert.equal(await readFile(file, 'utf8'), previous, '检测环境断网不得覆盖所有站点状态');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(updateFriendHealth({ root, signal: controller.signal, log: () => {} }));
  assert.equal(await readFile(file, 'utf8'), previous);
});

test('deploy CLI and registered steps have a single entry and an explicit offline mode', async () => {
  assert.deepEqual(deploymentSteps().map(step => step.id), ['preflight', 'hugo-tool', 'identity', 'friends', 'images', 'hugo-build', 'artifacts']);
  assert.equal(parseOptions([]).offline, false);
  const options = parseOptions(['--offline', '--destination=/var/tmp/output', '--baseURL', 'https://example.com/blog/']);
  assert.equal(options.offline, true);
  assert.equal(options.destination, '/var/tmp/output');
  assert.deepEqual(options.hugoArgs, ['--baseURL', 'https://example.com/blog/']);
  assert.throws(() => parseOptions(['--source', '/elsewhere']), /source/);
  assert.throws(() => parseOptions(['--destination']), /目录/);
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.buildCommand, 'npm run deploy');
  assert.equal(config.installCommand, 'npm ci');
  assert.equal(pkg.scripts.build, pkg.scripts.deploy);
  assert.equal(config.crons, undefined);
  assert.equal(config.functions['api/daily-deploy.js'], undefined);
  const ci = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(ci, /npm run (deploy|check:friends|check:deploy)|schedule:/, 'CI 不执行友链检测或每日更新');
});

test('Workers static build removes restored route and legacy remote-cache artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-worker-output-'));
  const destination = path.join(root, 'public');
  const stale = path.join(destination, '_routes.json');
  const legacyIndex = path.join(destination, 'xeu-images/image-cache-v3.json');
  const legacyBundle = path.join(destination, 'xeu-images/image-cache-v3.bin');
  await mkdir(path.dirname(legacyIndex), { recursive: true });
  await writeFile(stale, '{"include":["/api/*"]}\n');
  await writeFile(legacyIndex, '{}\n');
  await writeFile(legacyBundle, 'legacy');
  const step = deploymentSteps().find(item => item.id === 'hugo-build');
  await step.run({ root, destination, hugo: '/bin/true', hugoArgs: [], env: {} }, { log: () => {} });
  for (const file of [stale, legacyIndex, legacyBundle]) await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('daily workflow pushes an empty commit and preserves a concurrent update when retrying', async () => {
  const workflow = await readFile(new URL('../.github/workflows/daily-deploy.yml', import.meta.url), 'utf8');
  const script = workflow.match(/        run: \|\n([\s\S]+)$/)[1].replace(/^ {10}/gm, '');
  const temp = await mkdtemp(path.join(tmpdir(), 'xeu-daily-deploy-'));
  const remote = path.join(temp, 'origin.git');
  const root = path.join(temp, 'daily');
  const other = path.join(temp, 'concurrent');
  const git = (args, cwd = temp) => command('git', args, { cwd, capture: true });
  await git(['init', '--bare', '--initial-branch=production', remote]);
  await git(['clone', remote, root]);
  const configure = async cwd => {
    await git(['config', 'user.name', 'Test'], cwd);
    await git(['config', 'user.email', 'test@example.org'], cwd);
  };
  await configure(root);
  await writeFile(path.join(root, 'README.md'), 'original\n');
  await git(['add', 'README.md'], root);
  await git(['commit', '-m', 'seed'], root);
  await git(['push', 'origin', 'production'], root);
  await git(['clone', remote, other]);
  await configure(other);
  await writeFile(path.join(other, 'README.md'), 'concurrent update\n');
  await git(['commit', '-am', 'concurrent update'], other);
  await git(['push', 'origin', 'production'], other);
  const parent = await git(['rev-parse', 'HEAD'], other);
  const tree = await git(['rev-parse', 'HEAD^{tree}'], other);

  // Execute the actual workflow script from a stale checkout so its first push fails.
  await command('bash', ['-c', script], { cwd: root, env: { ...process.env, DEPLOY_BRANCH: 'production' } });
  assert.equal(await git(['--git-dir', remote, 'rev-parse', 'production^']), parent);
  assert.equal(await git(['--git-dir', remote, 'rev-parse', 'production^{tree}']), tree, '刷新提交不能修改任何文件');
  assert.equal(await git(['--git-dir', remote, 'rev-list', '--count', 'production']), '3');
  assert.equal(await git(['--git-dir', remote, 'log', '-1', '--format=%s', 'production']), 'chore: daily deployment refresh');
  assert.equal(await git(['status', '--porcelain'], root), '');
});

test('real Hugo rendering clears recovered status, preserves new failures and supports subpaths', { skip: !process.env.HUGO_BIN }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-health-render-'));
  for (const dir of ['layouts/_default', 'layouts/partials', 'content', 'data/xeu']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'config.toml'), 'baseURL = "https://example.org/blog/"\ndisableKinds = ["taxonomy", "term", "RSS", "sitemap"]\n');
  await writeFile(path.join(root, 'content/friends.md'), '---\ntitle: 友链\nlayout: friends\n---\n');
  await writeFile(path.join(root, 'layouts/_default/baseof.html'), '{{ block "main" . }}{{ end }}');
  await writeFile(path.join(root, 'layouts/partials/comments.html'), '');
  await copyFile(new URL('../themes/xeu/layouts/_default/friends.html', import.meta.url), path.join(root, 'layouts/_default/friends.html'));
  await copyFile(new URL('../themes/xeu/layouts/partials/friend-card.html', import.meta.url), path.join(root, 'layouts/partials/friend-card.html'));
  await copyFile(new URL('../themes/xeu/layouts/partials/friend-application.html', import.meta.url), path.join(root, 'layouts/partials/friend-application.html'));
  await writeFile(path.join(root, 'data/friends.json'), JSON.stringify([
    { title: 'Recovered', description: 'Recovered site', website: 'https://recovered.example/', image: '/friends/one.webp', health: '526' },
    { title: 'Unavailable', description: 'Unavailable site', website: 'https://down.example/', image: '/friends/two.webp', health: '' },
  ]));
  await writeFile(path.join(root, 'data/xeu/friend-health.json'), JSON.stringify({
    sites: { 'https://recovered.example/': { health: '' }, 'https://down.example/': { health: 'HTTP 404' } },
  }));
  await command(process.env.HUGO_BIN, ['--source', root, '--destination', path.join(root, 'public'), '--noBuildLock'], { env: { ...process.env, SHIUE_IMAGES_READY: '1' } });
  const html = await readFile(path.join(root, 'public/friends/index.html'), 'utf8');
  assert.equal((html.match(/friend-card--away/g) || []).length, 1);
  assert.ok(html.indexOf('Recovered') < html.indexOf('暂时离开'), '恢复站点必须回到正常分组');
  assert.ok(html.indexOf('Unavailable') > html.indexOf('暂时离开'));
  assert.match(html, /friend-status">HTTP 404/);
  assert.match(html, /src="\/blog\/friends\/one.webp"/);
  assert.doesNotMatch(html, /迁移|证书已过期|526/);
});
