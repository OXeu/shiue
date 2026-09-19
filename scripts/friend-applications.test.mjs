import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleSubmission as submit } from '../api/submissions.js';
import { fixtureToken, mockSiteverify } from './fixtures/turnstile.mjs';
const handleSubmission = (request, options = {}) => submit(request, { ...options, fetchImpl: mockSiteverify(options.fetchImpl) });
import { APPROVAL_TTL, approvalClaim, commentSecret, sign, validateComment, verify } from '../server/comments/core.js';
import { turnstileChallenge, TURNSTILE_TTL, verifyTurnstile } from '../server/turnstile.js';
import { APPROVAL_PURPOSE, friendClaim, PUBLISH_PURPOSE, validateFriend } from '../server/friends/core.js';
import { publishFriend, readFriendEnvelope } from './publish-friend.mjs';

const now = Date.parse('2026-09-18T12:00:00.000Z');
const env = {
  COMMENTS_SITE_URL: 'https://blog.example.org/', COMMENTS_APPROVAL_SECRET: 'a'.repeat(64), COMMENTS_WORKFLOW_SECRET: 'b'.repeat(64),
  TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret-key',
  RESEND_API_KEY: 'resend-test-secret', COMMENTS_EMAIL_FROM: 'Blog <blog@example.org>', COMMENTS_EMAIL_TO: 'owner@example.org',
  COMMENTS_GITHUB_TOKEN: 'github-test-secret', COMMENTS_GITHUB_REPOSITORY: 'owner/blog', COMMENTS_GITHUB_BRANCH: 'master',
};
const site = new URL(env.COMMENTS_SITE_URL);
const input = { id: randomUUID(), title: '<script>站点</script>', website: 'https://friend.example.org/', description: '<img src=x onerror=alert(1)> $(echo unsafe)', icon: '', createdAt: new Date(now).toISOString(), contact: '', consent: true };
const request = (body, headers = {}, method = 'POST') => new Request(new URL('api/submissions', site), { method, headers: { origin: site.origin, 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify({ type: 'friend', action: 'submit', ...body }) } : {}) });
const challengeRequest = (body, ...args) => request({ ...body, action: 'challenge' }, ...args);
const noFetch = async () => assert.fail('unexpected external request');
const deps = extra => ({ env, now, fetchImpl: noFetch, ...extra });
const approval = (changes = {}) => sign({ ...friendClaim(input, site, now), ...changes }, env.COMMENTS_APPROVAL_SECRET, APPROVAL_PURPOSE);
const envelope = (friend = validateFriend(input), changes = {}) => sign({ v: 1, friend, repository: 'owner/blog', approvedAt: new Date(now).toISOString(), expiresAt: now + APPROVAL_TTL, ...changes }, env.COMMENTS_WORKFLOW_SECRET, PUBLISH_PURPOSE);
const solve = task => fixtureToken(task, now);
const turnstileToken = solve(turnstileChallenge(validateFriend(input), 'friend', env));

test('switching submission type cannot reuse proofs, approvals or comment-only notifications', async () => {
  const comment = { id: input.id, path: '/p/example/', name: '读者', message: '留言', createdAt: input.createdAt, website: '', consent: true };
  const page = { path: comment.path, title: '文章', directory: 'post/example', commentIds: [] };
  const commentToken = sign(approvalClaim(comment, page, site, now), env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1');
  let calls = 0;
  const options = deps({ pages: async () => [page], fetchImpl: async () => { calls++; throw new Error('unexpected external request'); } });
  for (const action of ['preview', 'approve']) {
    assert.equal((await handleSubmission(request({ type: 'comment', action, token: approval() }), options)).status, 400);
    assert.equal((await handleSubmission(request({ action, token: commentToken }), options)).status, 400);
  }
  assert.equal((await handleSubmission(request({ action: 'notify', token: approval() }), options)).status, 400);
  const wrongPurpose = solve(turnstileChallenge(validateComment(comment), 'friend', env));
  assert.equal((await handleSubmission(request({ ...comment, type: 'comment', turnstileToken: wrongPurpose }), options)).status, 403);
  assert.equal((await handleSubmission(request({ ...comment, type: 'comment', turnstileToken }), options)).status, 403);
  const commentProof = solve(turnstileChallenge(validateComment(comment), 'comment', env));
  assert.equal((await handleSubmission(request({ ...input, turnstileToken: commentProof }), options)).status, 403);
  for (const [type, token] of [['comment', commentToken], ['friend', approval()]]) {
    const response = await handleSubmission(request({ type, action: 'approve', token }), { ...options, env: { ...env, COMMENTS_GITHUB_BRANCH: '-invalid' } });
    assert.equal(response.status, 503);
  }
  assert.equal(calls, 0);
});

test('friend applications work from challenge through publish signature with only the master secret', async () => {
  const masterEnv = { ...env, COMMENTS_SECRET: 'friend-master-secret-test'.repeat(3) };
  for (const name of ['COMMENTS_APPROVAL_SECRET', 'COMMENTS_WORKFLOW_SECRET']) delete masterEnv[name];
  const options = deps({ env: masterEnv });
  const challenge = await handleSubmission(challengeRequest(input), options);
  assert.equal(challenge.status, 200);
  const masterProof = solve(await challenge.json());
  let token;
  const submitted = await handleSubmission(request({ ...input, turnstileToken: masterProof }), { ...options, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    const email = JSON.parse(init.body);
    token = new URLSearchParams(email.text.match(/https:\/\/[^\s]+friend-review\/[^\s]+/)[0].split('#')[1]).get('token');
    return Response.json({ id: 'mail-id' });
  } });
  assert.equal(submitted.status, 202);
  assert.equal((await handleSubmission(request({ action: 'preview', token }), options)).status, 200);
  const approved = await handleSubmission(request({ action: 'approve', token }), { ...options, fetchImpl: async (url, init) => {
    assert.match(url, /publish-friend.yml\/dispatches$/);
    const published = readFriendEnvelope({ envelope: JSON.parse(init.body).inputs.envelope, secret: commentSecret({ COMMENTS_SECRET: masterEnv.COMMENTS_SECRET }, 'workflow'), repository: 'owner/blog', now });
    assert.deepEqual(published, validateFriend(input));
    return new Response(null, { status: 204 });
  } });
  assert.equal(approved.status, 202);
});

test('validation rejects invalid URLs, times, lengths, consent and honeypot', async () => {
  for (const changes of [
    { title: '' }, { title: 'x'.repeat(81) }, { description: 'x'.repeat(201) }, { description: '' },
    { title: 'header\r\ninjection' }, { createdAt: 'yesterday' }, { id: '../path' },
    { consent: false }, { contact: 'bot' },
    ...['javascript:alert(1)', 'data:text/plain,test', 'file:///tmp/a', 'https://user:pass@example.org/', 'https://example.org:8443/', 'https://127.0.0.1/', 'http://2130706433', 'http://[::1]/', 'http://service.local/', 'http://localhost/'].flatMap(url => [{ website: url }, { icon: url }]),
  ]) assert.equal((await handleSubmission(challengeRequest({ ...input, ...changes }), deps())).status, 400, JSON.stringify(changes));
  for (const createdAt of [new Date(now - 86400001).toISOString(), new Date(now + 300001).toISOString()]) {
    assert.equal((await handleSubmission(request({ ...input, createdAt }), deps())).status, 400, 'submit still rejects stale times without a renewed challenge');
  }
  assert.equal(validateFriend({ ...input, website: 'https://朋友.com/#fragment' }).website, 'https://xn--iorv16b.com/');
  assert.equal((await handleSubmission(challengeRequest({ ...input, description: 'x'.repeat(27000) }), deps())).status, 413);
});

test('all actions enforce origin, POST, JSON, environment and configuration', async () => {
  for (const action of ['challenge', 'submit', 'preview', 'approve']) {
    assert.equal((await handleSubmission(request({ action }, {}, 'GET'), deps())).status, 405);
    assert.equal((await handleSubmission(request({ action }, { origin: 'https://evil.example' }), deps())).status, 403);
    assert.equal((await handleSubmission(request({ action }, { 'sec-fetch-site': 'cross-site' }), deps())).status, 403);
    assert.equal((await handleSubmission(request({ action }, { 'content-type': 'text/plain' }), deps())).status, 415);
    assert.equal((await handleSubmission(request({ action }), deps({ env: { ...env, VERCEL_ENV: 'preview' } }))).status, 503);
  }
  for (const changes of [{ TURNSTILE_SITE_KEY: '' }, { TURNSTILE_SECRET_KEY: '' }, { COMMENTS_SITE_URL: '' }]) {
    assert.equal((await handleSubmission(challengeRequest(input), deps({ env: { ...env, ...changes } }))).status, 503);
  }
});

test('Turnstile binds every application field and isolates comment tokens', async () => {
  const response = await handleSubmission(challengeRequest(input), deps());
  assert.equal(response.status, 200);
  const task = await response.json();
  assert.equal(task.provider, 'turnstile');
  assert.equal(task.action, 'friend');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(task), /<script>|friend\.example|secret/);
  await verifyTurnstile(turnstileToken, validateFriend(input), 'friend', site, env, mockSiteverify(), now);
  const commentToken = solve(turnstileChallenge(validateFriend(input), 'comment', env));
  assert.equal((await handleSubmission(request({ ...input, turnstileToken: commentToken }), deps())).status, 403);
  for (const changes of [{ title: 'changed' }, { website: 'https://other.example.org' }, { description: 'changed' }, { icon: 'https://example.org/image.png' }, { id: randomUUID() }, { createdAt: new Date(now + 1000).toISOString() }]) {
    assert.equal((await handleSubmission(request({ ...input, ...changes, turnstileToken }), deps())).status, 403);
  }
  assert.equal((await handleSubmission(request(input), deps())).status, 403);
  assert.equal((await handleSubmission(request({ ...input, turnstileToken }), deps({ now: now + TURNSTILE_TTL }))).status, 410);
});

test('mail is escaped, idempotent, fixed-recipient and never discloses approval to applicant', async () => {
  const mails = [];
  const keys = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    mails.push(JSON.parse(init.body)); keys.push(init.headers['idempotency-key']);
    return Response.json({ id: 'mail-id' });
  };
  for (let i = 0; i < 2; i++) {
    const response = await handleSubmission(request({ ...input, turnstileToken, to: 'attacker@example.org' }), deps({ fetchImpl }));
    assert.equal(response.status, 202);
    assert.doesNotMatch(await response.text(), /token|secret|friend-review|owner@example/);
  }
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(mails[0].to, [env.COMMENTS_EMAIL_TO]);
  assert.doesNotMatch(mails[0].html, /<script>|<img/);
  const url = new URL(mails[0].text.match(/https:\/\/blog.example.org\/friend-review\/[^\n]+/)[0]);
  assert.equal(url.search, '');
  assert.equal(verify(new URLSearchParams(url.hash.slice(1)).get('token'), env.COMMENTS_APPROVAL_SECRET, APPROVAL_PURPOSE).friend.title, input.title);
  for (const fetchImpl of [async () => new Response('secret', { status: 500 }), async () => { throw new Error(env.RESEND_API_KEY); }, async () => Response.json({})]) {
    const response = await handleSubmission(request({ ...input, turnstileToken }), deps({ fetchImpl }));
    assert.ok(response.status >= 500);
    assert.doesNotMatch(await response.text(), /resend-test-secret/);
  }
});

test('preview never publishes, approval uses separate signed workflow; invalid tokens fail closed', async () => {
  const preview = await handleSubmission(request({ action: 'preview', token: approval() }), deps());
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).friend, validateFriend(input));
  let dispatched;
  const response = await handleSubmission(request({ action: 'approve', token: approval(), repository: 'attacker/repo' }), deps({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/owner/blog/actions/workflows/publish-friend.yml/dispatches');
    dispatched = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  } }));
  assert.equal(response.status, 202);
  assert.equal(dispatched.ref, 'master');
  assert.deepEqual(readFriendEnvelope({ envelope: dispatched.inputs.envelope, secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now }), validateFriend(input));
  assert.doesNotMatch(await response.text(), /envelope|secret|token/);
  for (const token of ['broken', approval().replace(/^./, 'X'), envelope(), sign(friendClaim(input, site, now), env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1'), approval({ site: 'https://elsewhere.org/' })]) {
    assert.equal((await handleSubmission(request({ action: 'approve', token }), deps())).status, 400);
  }
  assert.equal((await handleSubmission(request({ action: 'approve', token: approval() }), deps({ now: now + APPROVAL_TTL }))).status, 410);
  assert.equal((await handleSubmission(request({ action: 'approve', token: approval() }), deps({ fetchImpl: async () => new Response(null, { status: 500 }) }))).status, 502);
  for (const changes of [{ repository: 'other/repo' }, { expiresAt: now }, { approvedAt: new Date(now + 600000).toISOString() }]) {
    assert.throws(() => readFriendEnvelope({ envelope: envelope(undefined, changes), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now }));
  }
});

test('Git publishing preserves concurrent array edits and code, avoids duplicates, and leaves failed imports unpublished', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'xeu-friend-git-test-'));
  const remote = path.join(temp, 'origin.git');
  const root = path.join(temp, 'first');
  const other = path.join(temp, 'second');
  const git = (args, cwd = temp) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git(['init', '--bare', '--initial-branch=master', remote]);
  git(['clone', remote, root]);
  const configure = cwd => { git(['config', 'user.name', 'Test'], cwd); git(['config', 'user.email', 'test@example.org'], cwd); };
  configure(root);
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/friends.json'), '[]\n');
  await writeFile(path.join(root, 'code.txt'), 'existing code');
  git(['add', '.'], root); git(['commit', '-m', 'seed'], root); git(['push', 'origin', 'master'], root);
  git(['clone', remote, other]); configure(other);
  const importer = async (friend, { root }) => {
    const list = JSON.parse(await readFile(path.join(root, 'data/friends.json'), 'utf8'));
    const entry = { ...friend, image: `/friends/${new URL(friend.website).hostname}-icon.webp`, iconSource: friend.icon || `${friend.website}favicon.ico`, health: '' };
    list.push(entry);
    await mkdir(path.join(root, 'static/friends'), { recursive: true });
    await writeFile(path.join(root, 'static', entry.image), 'test icon');
    await writeFile(path.join(root, 'data/friends.json'), JSON.stringify(list));
    return entry;
  };
  const options = { root, branch: 'master', envelope: envelope(), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now, importer };
  let raced = false;
  let imports = 0;
  await publishFriend({ ...options, importer: async (...args) => {
    imports++;
    if (!raced) {
      raced = true;
      await writeFile(path.join(other, 'code.txt'), 'concurrent code');
      git(['add', 'code.txt'], other); git(['commit', '-m', 'code update'], other); git(['push', 'origin', 'master'], other);
      await publishFriend({ ...options, root: other, envelope: envelope({ ...validateFriend(input), id: randomUUID(), website: 'https://second.example.org/' }) });
    }
    return importer(...args);
  } });
  assert.equal(imports, 2, 'push conflict must re-import from latest remote');
  const list = JSON.parse(git(['--git-dir', remote, 'show', 'master:data/friends.json']));
  assert.deepEqual(list.map(entry => entry.website).sort(), ['https://friend.example.org/', 'https://second.example.org/']);
  assert.equal(git(['--git-dir', remote, 'show', 'master:code.txt']), 'concurrent code');
  const head = git(['--git-dir', remote, 'rev-parse', 'master']);
  assert.equal((await publishFriend({ ...options, importer: noFetch })).created, false);
  assert.equal((await publishFriend({ ...options, envelope: envelope({ ...validateFriend(input), website: 'http://friend.example.org', title: 'do not overwrite' }), importer: noFetch })).created, false);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'master']), head);
  await assert.rejects(publishFriend({ ...options, envelope: approval() }));
  await assert.rejects(publishFriend({ ...options, envelope: envelope({ ...validateFriend(input), website: 'https://broken.example.org/' }), importer: async () => { throw new Error('bad icon'); } }));
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'master']), head);
  assert.equal(git(['status', '--porcelain'], root), '');
  assert.equal(git(['worktree', 'list', '--porcelain'], root).split('worktree ').length, 2, 'temporary worktrees cleaned up');
});
