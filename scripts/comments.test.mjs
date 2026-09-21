import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleSubmission as submit } from '../api/submissions.js';
import { fixtureToken, mockSiteverify } from './fixtures/turnstile.mjs';
const handleSubmission = (request, options = {}) => submit(request, { ...options, fetchImpl: mockSiteverify(options.fetchImpl) });
import { APPROVAL_TTL, approvalClaim, commentSecret, readApproval, sign, validateComment, validateStoredComment, verify } from '../server/comments/core.js';
import { openCommentEmail, sealComment } from '../server/comments/email.js';
import { turnstileChallenge, TURNSTILE_TTL, verifyTurnstile } from '../server/turnstile.js';
import { appendApprovedComment } from './publish-comment.mjs';
import { pushComment } from './push-comment.mjs';
import { commentFile, parseCommentFile } from '../server/comments/storage.js';

const now = Date.parse('2026-09-17T20:00:00.000Z');
const env = {
  COMMENTS_SITE_URL: 'https://blog.example.org/', COMMENTS_APPROVAL_SECRET: 'a'.repeat(64), COMMENTS_WORKFLOW_SECRET: 'b'.repeat(64),
  RESEND_API_KEY: 'resend-test-secret', COMMENTS_EMAIL_FROM: 'Blog <blog@example.org>', COMMENTS_EMAIL_TO: 'owner@example.org',
  COMMENTS_GITHUB_TOKEN: 'github-test-secret', COMMENTS_GITHUB_REPOSITORY: 'owner/blog', COMMENTS_GITHUB_BRANCH: 'master',
  TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret-key',
  COMMENTS_EMAIL_SECRET: 'email-encryption-test-only'.repeat(3),
};
const masterEnv = { ...env, COMMENTS_SECRET: 'single-master-secret-for-tests'.repeat(3) };
for (const name of ['COMMENTS_APPROVAL_SECRET', 'COMMENTS_WORKFLOW_SECRET', 'COMMENTS_EMAIL_SECRET']) delete masterEnv[name];
const input = { id: 'fe251682-6cc0-40df-bf31-6d48c12a985c', path: '/p/example/', name: '读者', message: '第一行\n<script>alert(1)</script> ${{ secrets.TOKEN }} $(echo unsafe)', createdAt: new Date(now).toISOString(), website: '', consent: true };
const directory = 'post/source-example';
const pages = async () => [{ path: input.path, title: '文章标题 <test>', directory, commentIds: [] }];
async function seedArticle(root, articleDirectory = directory) {
  await mkdir(path.join(root, 'content', articleDirectory), { recursive: true });
  await writeFile(path.join(root, 'content', articleDirectory, 'index.md'), '---\ntitle: Example\nslug: example\n---\nArticle\n');
}
const deps = extra => ({ env, now, pages, ...extra });
const request = (data, headers = {}, method = 'POST') => new Request('https://blog.example.org/api/submissions', { method, headers: { origin: 'https://blog.example.org', 'content-type': 'application/json', ...headers }, ...(method !== 'GET' ? { body: JSON.stringify({ type: 'comment', action: 'submit', ...data }) } : {}) });
const challengeRequest = (body, ...args) => request({ ...body, action: 'challenge' }, ...args);
const claim = () => approvalClaim(input, { title: '文章标题' }, new URL(env.COMMENTS_SITE_URL), now);
const approval = () => sign(claim(), env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1');
const envelope = (comment = claim().comment, options = {}) => sign({ v: 1, repository: 'owner/blog', directory, comment, approvedAt: new Date(now).toISOString(), expiresAt: now + APPROVAL_TTL, ...options }, env.COMMENTS_WORKFLOW_SECRET, 'comment-publish-v1');
const solve = (task, at = now) => fixtureToken(task, at);
input.turnstileToken = solve(turnstileChallenge(validateComment(input), 'comment', env));

test('unified endpoint requires an explicit type and action before reading pages or calling services', async () => {
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('unexpected side effect'); };
  const options = deps({ fetchImpl: unexpected, pages: unexpected });
  for (const type of [undefined, null, '', 'comments', 'constructor', '__proto__', ['comment'], {}]) {
    const response = await handleSubmission(request({ ...input, type }), options);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '未知提交类型。');
  }
  for (const type of ['comment', 'friend']) {
    for (const action of [undefined, null, '', 'delete', 'constructor', '__proto__', ['submit'], {}]) {
      const response = await handleSubmission(request({ ...input, type, action }), options);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, '未知提交操作。');
    }
  }
  assert.equal((await handleSubmission(request({ type: 'friend', action: 'notify', token: approval() }), options)).status, 400);
  assert.equal(calls, 0);
});

test('one master secret derives isolated keys while existing configurations retain their keys', () => {
  const purposes = ['approval', 'workflow', 'email'];
  const derived = purposes.map(purpose => commentSecret(masterEnv, purpose));
  assert.equal(new Set(derived).size, purposes.length);
  assert.ok(!derived.includes(masterEnv.COMMENTS_SECRET));
  const value = { id: input.id };
  const token = sign(value, derived[0], 'test-purpose');
  for (const secret of derived.slice(1)) assert.throws(() => verify(token, secret, 'test-purpose'));
  const mixed = { ...env, COMMENTS_SECRET: masterEnv.COMMENTS_SECRET };
  for (const purpose of purposes) {
    assert.equal(commentSecret(mixed, purpose), env[`COMMENTS_${purpose.toUpperCase()}_SECRET`]);
    assert.throws(() => commentSecret({}, purpose), { status: 503 });
    assert.throws(() => commentSecret({ COMMENTS_SECRET: 'too-short' }, purpose), { status: 503 });
  }
  assert.equal(readApproval(approval(), commentSecret(mixed, 'approval'), new URL(env.COMMENTS_SITE_URL), now).comment.id, input.id);
  const stored = sealComment({ ...input, email: 'legacy@example.org' }, env.COMMENTS_EMAIL_SECRET);
  assert.equal(openCommentEmail(stored, commentSecret(mixed, 'email')), 'legacy@example.org');
  assert.equal(commentSecret({ ...masterEnv, COMMENTS_WORKFLOW_SECRET: '' }, 'workflow'), derived[1], 'GitHub 未配置的旧 Secret 为空字符串');
});

test('a single master secret covers submission, approval, encrypted publishing, reply mail and notification retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-master-'));
  await seedArticle(root);
  const stored = [];
  const recipients = [];
  const pageList = async () => [{ ...(await pages())[0], commentIds: stored.map(comment => comment.id), notificationEmails: Object.fromEntries(stored.map(comment => [comment.id, { emailEncrypted: comment.emailEncrypted, emailHash: comment.emailHash }])) }];
  for (let depth = 0; depth < 2; depth++) {
    const body = { ...input, id: `fe251682-6cc0-40df-bf31-${String(depth).padStart(12, '0')}`, email: `author${depth}@example.org`, ...(depth ? { parentId: stored[0].id } : {}) };
    const options = deps({ env: masterEnv, pages: pageList });
    const challenged = await handleSubmission(challengeRequest(body), options);
    assert.equal(challenged.status, 200);
    const turnstileToken = solve(await challenged.json());
    let token;
    const submitted = await handleSubmission(request({ ...body, turnstileToken }), { ...options, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.resend.com/emails');
      token = JSON.parse(init.body).text.match(/#token=([\w.-]+)/)[1];
      return Response.json({ id: 'moderation-mail' });
    } });
    assert.equal(submitted.status, 202);
    const preview = await handleSubmission(request({ action: 'preview', token }), options);
    assert.equal(preview.status, 200);
    const approved = await handleSubmission(request({ action: 'approve', token }), { ...options, fetchImpl: async (url, init) => {
      if (url.startsWith('https://api.github.com/')) {
        const result = await appendApprovedComment({ root, envelope: JSON.parse(init.body).inputs.envelope, secret: commentSecret({ COMMENTS_SECRET: masterEnv.COMMENTS_SECRET }, 'workflow'), repository: 'owner/blog', now });
        const comment = JSON.parse(await readFile(path.join(root, result.relative), 'utf8'));
        assert.equal(comment.email, undefined);
        assert.equal(openCommentEmail(comment, commentSecret(masterEnv, 'email')), body.email);
        stored.push(comment);
        return new Response(null, { status: 204 });
      }
      const to = JSON.parse(init.body).to[0];
      if (depth && to === 'author0@example.org') return new Response(null, { status: 503 });
      recipients.push(to);
      return Response.json({ id: 'notification-mail' });
    } });
    assert.equal(approved.status, 202);
    const result = await approved.json();
    if (depth) {
      assert.equal(result.notifications.failed, 1);
      const retried = await handleSubmission(request({ action: 'notify', token, notificationToken: result.notificationToken }), { ...options, fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.resend.com/emails', '重试不能再发起 GitHub Action');
        recipients.push(JSON.parse(init.body).to[0]);
        return Response.json({ id: 'retry-mail' });
      } });
      assert.deepEqual((await retried.json()).notifications, { sent: 1, failed: 0 });
    } else assert.deepEqual(result.notifications, { sent: 1, failed: 0 });
  }
  assert.deepEqual(recipients, ['author0@example.org', 'author1@example.org', 'author0@example.org']);
});

test('challenge returns public Turnstile configuration and a canonical content digest', async () => {
  const response = await handleSubmission(challengeRequest(input), deps());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const task = await response.json();
  assert.equal(task.provider, 'turnstile');
  assert.equal(task.sitekey, env.TURNSTILE_SITE_KEY);
  assert.equal(task.action, 'comment');
  assert.match(task.cData, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(task), /test-secret-key|resend-test|github-test|owner@example|读者|<script>/);
  for (const [body, status] of [[{ ...input, consent: false }, 400], [{ ...input, website: 'spam' }, 400], [{ ...input, path: '/not-enabled/' }, 400], [{ ...input, message: 'x'.repeat(27000) }, 413]]) {
    assert.equal((await handleSubmission(challengeRequest(body), deps())).status, status);
  }
  for (const extra of [{ TURNSTILE_SECRET_KEY: '' }, { TURNSTILE_SITE_KEY: '' }, { VERCEL_ENV: 'preview' }]) {
    assert.equal((await handleSubmission(challengeRequest(input), deps({ env: { ...env, ...extra } }))).status, 503);
  }
  assert.equal((await handleSubmission(challengeRequest(input, {}, 'GET'), deps())).status, 405);
  assert.equal((await handleSubmission(challengeRequest(input, { origin: 'https://evil.example' }), deps())).status, 403);
});

test('Turnstile binds canonical content, site and action before sending mail', async () => {
  const valid = validateComment(input);
  const site = new URL(env.COMMENTS_SITE_URL);
  const verify = (token, content = valid, host = site, at = now) => verifyTurnstile(token, content, 'comment', host, env, mockSiteverify(), at);
  await verify(input.turnstileToken);
  for (const turnstileToken of [undefined, {}, '', 'invalid', 'x'.repeat(2049), approval()]) {
    assert.equal((await handleSubmission(request({ ...input, turnstileToken }), deps())).status, 403);
  }
  assert.equal((await handleSubmission(request({ ...input, turnstileToken: undefined, proof: { token: 'legacy', nonce: '0' } }), deps())).status, 403);
  for (const change of [{ id: 'ae251682-6cc0-40df-bf31-6d48c12a985c' }, { name: 'someone else' }, { message: 'different' }, { createdAt: new Date(now + 1).toISOString() }, { path: '/p/another/' }, { parentId: 'ae251682-6cc0-40df-bf31-6d48c12a985c' }]) {
    await assert.rejects(verify(input.turnstileToken, { ...valid, ...change }), { status: 403 });
  }
  await assert.rejects(verify(input.turnstileToken, valid, new URL('https://other.example/')), { status: 403 });
  await assert.rejects(verify(input.turnstileToken, valid, site, now - 60000), { status: 403 });
  assert.equal((await handleSubmission(request(input), deps({ now: now + TURNSTILE_TTL }))).status, 410);
});

test('submission sends escaped details to a fixed recipient; approval capability never reaches the visitor', async () => {
  let sent;
  const response = await handleSubmission(request({ ...input, title: '伪造标题', to: 'attacker@example.org' }), deps({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.redirect, 'manual');
    sent = { ...init, email: JSON.parse(init.body) };
    return Response.json({ id: 'email-receipt' });
  } }));
  assert.equal(response.status, 202);
  const body = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(body, /token|secret|owner@example|signature|#token/);
  assert.deepEqual(sent.email.to, ['owner@example.org']);
  assert.match(sent.email.subject, /文章标题/);
  assert.doesNotMatch(sent.email.html, /<script>|伪造标题/);
  assert.match(sent.email.html, /&lt;script&gt;/);
  assert.ok(sent.email.text.includes(input.message));
  const token = sent.email.text.match(/#token=([\w.-]+)/)[1];
  assert.equal(readApproval(token, env.COMMENTS_APPROVAL_SECRET, new URL(env.COMMENTS_SITE_URL), now).comment.message, input.message);
  assert.ok(sent.headers['idempotency-key'].length < 256);
});

test('retry of the same logical submission produces exactly the same email and idempotency key', async () => {
  const requests = [];
  const fetchImpl = async (_, init) => { requests.push(init); return Response.json({ id: 'receipt' }); };
  await handleSubmission(request(input), deps({ fetchImpl }));
  await handleSubmission(request(input), deps({ fetchImpl, now: now + 60000 }));
  const turnstileToken = solve(turnstileChallenge(validateComment(input), 'comment', env), now + TURNSTILE_TTL);
  await handleSubmission(request({ ...input, turnstileToken }), deps({ fetchImpl, now: now + TURNSTILE_TTL }));
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
  assert.equal(requests[0].headers['idempotency-key'], requests[2].headers['idempotency-key'], 'renewing a challenge must not change email idempotency');
});

test('full production-config flow without rate-limit settings: challenge → email → preview → dispatch → file', async t => {
  const production = { ...env, VERCEL: '1', VERCEL_ENV: 'production' };
  const realFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected outbound call'); });
  const calls = [];
  let token;
  const challenge = await handleSubmission(challengeRequest(input), deps({ env: production }));
  assert.equal(challenge.status, 200);
  const turnstileToken = solve(await challenge.json());
  const submitted = await handleSubmission(request({ ...input, turnstileToken }), deps({ env: production, fetchImpl: async (url, options) => {
    calls.push(url);
    token = JSON.parse(options.body).text.match(/#token=([\w.-]+)/)[1];
    return Response.json({ id: 'email-id' });
  } }));
  assert.equal(submitted.status, 202);
  const preview = await handleSubmission(request({ action: 'preview', token }), deps({ env: production }));
  assert.equal(preview.status, 200);
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-flow-'));
  await seedArticle(root);
  let file;
  const approved = await handleSubmission(request({ action: 'approve', token }), deps({ env: production, fetchImpl: async (url, options) => {
    calls.push(url);
    file = await appendApprovedComment({ root, envelope: JSON.parse(options.body).inputs.envelope, secret: env.COMMENTS_WORKFLOW_SECRET, repository: env.COMMENTS_GITHUB_REPOSITORY, now });
    return new Response(null, { status: 204 });
  } }));
  assert.equal(approved.status, 202);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, file.relative), 'utf8')), claim().comment);
  assert.deepEqual(calls, ['https://api.resend.com/emails', 'https://api.github.com/repos/owner/blog/actions/workflows/publish-comment.yml/dispatches']);
  assert.equal(realFetch.mock.callCount(), 0, 'no firewall or other hidden outbound calls');
});

test('bad input, honeypot, missing consent, oversized bodies, foreign origins and missing configuration fail before email', async () => {
  const noEmail = async () => assert.fail('must not send email');
  const invalid = [
    { ...input, website: 'bot' }, { ...input, consent: false }, { ...input, name: '' }, { ...input, message: 'x'.repeat(2001) },
    { ...input, path: '/p/not-enabled/' }, { ...input, path: '//evil.example/' }, { ...input, id: '../../file' },
    { ...input, createdAt: new Date(now - 2 * 86400000).toISOString() }, { ...input, createdAt: new Date(now + 86400000).toISOString() },
  ];
  for (const body of invalid) assert.equal((await handleSubmission(request(body), deps({ fetchImpl: noEmail }))).status, 400);
  assert.equal((await handleSubmission(request(input, { origin: 'https://evil.example' }), deps({ fetchImpl: noEmail }))).status, 403);
  assert.equal((await handleSubmission(request(input, { 'sec-fetch-site': 'cross-site' }), deps({ fetchImpl: noEmail }))).status, 403);
  assert.equal((await handleSubmission(request(input, { 'content-type': 'text/plain' }), deps({ fetchImpl: noEmail }))).status, 415);
  assert.equal((await handleSubmission(request({}, {}, 'GET'), deps({ fetchImpl: noEmail }))).status, 405);
  assert.equal((await handleSubmission(request({ ...input, padding: 'x'.repeat(27000) }), deps({ fetchImpl: noEmail }))).status, 413);
  assert.equal((await handleSubmission(request(input), deps({ fetchImpl: noEmail, env: { ...env, RESEND_API_KEY: '' } }))).status, 503);
  assert.equal((await handleSubmission(request(input), deps({ fetchImpl: noEmail, env: { ...env, VERCEL_ENV: 'preview' } }))).status, 503);
  const malformed = new Request('https://blog.example.org/api/submissions', { method: 'POST', headers: { origin: 'https://blog.example.org', 'content-type': 'application/json' }, body: '{' });
  assert.equal((await handleSubmission(malformed, deps({ fetchImpl: noEmail }))).status, 400);
});

test('upstream failures remain recoverable without disclosing credentials', async () => {
  for (const fetchImpl of [async () => new Response('secret', { status: 429 }), async () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } }), async () => { throw new Error(env.RESEND_API_KEY); }, async () => Response.json({})]) {
    const response = await handleSubmission(request(input), deps({ fetchImpl }));
    assert.ok(response.status >= 500);
    assert.doesNotMatch(await response.text(), /resend-test-secret|github-test-secret/);
  }
});

test('GET / preview cannot publish; confirmation dispatches a separately signed workflow payload', async () => {
  const noDispatch = async () => assert.fail('must not dispatch');
  assert.equal((await handleSubmission(request({}, {}, 'GET'), deps({ fetchImpl: noDispatch }))).status, 405);
  const preview = await handleSubmission(request({ action: 'preview', token: approval() }), deps({ fetchImpl: noDispatch }));
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).comment.name, input.name);
  let dispatched;
  const response = await handleSubmission(request({ action: 'approve', token: approval(), repository: 'attacker/repo' }), deps({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/owner/blog/actions/workflows/publish-comment.yml/dispatches');
    assert.equal(init.headers['user-agent'], 'OXeu-shiue-comment-publisher');
    dispatched = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  } }));
  assert.equal(response.status, 202);
  assert.equal(dispatched.ref, 'master');
  const value = verify(dispatched.inputs.envelope, env.COMMENTS_WORKFLOW_SECRET, 'comment-publish-v1');
  assert.deepEqual(value.comment, claim().comment);
  assert.equal(value.repository, 'owner/blog');
  assert.doesNotMatch(await response.text(), /secret|envelope|token/);
  assert.throws(() => verify(dispatched.inputs.envelope, env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1'));
});

test('tampered, expired and cross-site approvals cannot dispatch; GitHub errors are returned without request secrets', async () => {
  const noDispatch = async () => assert.fail();
  for (const token of ['not-a-token', `${approval().slice(0, 8)}X${approval().slice(9)}`, envelope()]) {
    assert.equal((await handleSubmission(request({ action: 'approve', token }), deps({ fetchImpl: noDispatch }))).status, 400);
  }
  assert.equal((await handleSubmission(request({ action: 'approve', token: approval() }), deps({ now: now + APPROVAL_TTL, fetchImpl: noDispatch }))).status, 410);
  assert.equal((await handleSubmission(request({ action: 'approve', token: approval() }, { origin: 'https://evil.example' }), deps({ fetchImpl: noDispatch }))).status, 403);
  const githubBody = {
    message: 'User-Agent Required. Please make sure your request has a User-Agent header.',
    errors: [{ resource: 'WorkflowDispatch', code: 'custom', field: 'headers' }],
    documentation_url: 'https://docs.github.com/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent',
    status: '403',
  };
  const githubResponse = await handleSubmission(request({ action: 'approve', token: approval() }), deps({
    fetchImpl: async () => Response.json(githubBody, { status: 403 }),
  }));
  assert.equal(githubResponse.status, 502);
  assert.deepEqual(await githubResponse.json(), {
    error: githubBody.message,
    upstream: { service: 'github', httpStatus: 403, body: githubBody },
  });
  const nonJSON = await handleSubmission(request({ action: 'approve', token: approval() }), deps({
    fetchImpl: async () => new Response(`upstream ${env.COMMENTS_GITHUB_TOKEN}`, { status: 500 }),
  }));
  assert.deepEqual(await nonJSON.json(), {
    error: 'GitHub API 请求失败（HTTP 500）。',
    upstream: { service: 'github', httpStatus: 500 },
  });
});

test('approved comments use exclusive UUID files, reject overwrites, preserve text, and require workflow signature', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-data-'));
  await seedArticle(root);
  const options = { root, envelope: envelope(), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now };
  const result = await appendApprovedComment(options);
  assert.equal(result.created, true);
  assert.equal(result.relative, commentFile(directory, input.id), '文章存储目录不能由公开 URL 猜测');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, result.relative), 'utf8')), claim().comment);
  assert.equal((await appendApprovedComment(options)).created, false);
  await assert.rejects(appendApprovedComment({ ...options, envelope: envelope({ ...claim().comment, message: 'changed' }) }), /拒绝覆盖/);
  await assert.rejects(appendApprovedComment({ ...options, envelope: approval() }));
  await assert.rejects(appendApprovedComment({ ...options, repository: 'other/repo' }));
  await assert.rejects(appendApprovedComment({ ...options, now: now + APPROVAL_TTL }));
  await assert.rejects(appendApprovedComment({ ...options, envelope: envelope({ ...claim().comment, id: '../../outside' }) }));
  assert.equal((await readdir(path.join(root, 'content', directory, 'comments'))).length, 1);
  await assert.rejects(readFile(path.join(root, 'data/comments', `${input.id}.json`)), { code: 'ENOENT' });
});

test('concurrent branches and duplicate approvals rebase safely without dropping comments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-git-'));
  const remote = path.join(root, 'remote.git');
  const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(root, ['init', '--bare', '--initial-branch=master', remote]);
  const clones = ['first', 'second', 'duplicate'].map(name => path.join(root, name));
  for (const clone of clones) {
    git(root, ['clone', remote, clone]);
    git(clone, ['config', 'user.name', 'Test']);
    git(clone, ['config', 'user.email', 'test@example.org']);
  }
  await writeFile(path.join(clones[0], 'README.md'), 'test\n');
  await seedArticle(clones[0]);
  git(clones[0], ['add', '.']); git(clones[0], ['commit', '-m', 'init']); git(clones[0], ['push', 'origin', 'master']);
  for (const clone of clones.slice(1)) git(clone, ['pull', 'origin', 'master']);
  const first = sealComment({ ...claim().comment, email: 'subscriber@example.org' }, env.COMMENTS_EMAIL_SECRET);
  const second = sealComment({ ...claim().comment, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321', message: '另一条评论', email: 'another@example.org' }, env.COMMENTS_EMAIL_SECRET);
  const duplicate = sealComment({ ...claim().comment, email: 'subscriber@example.org' }, env.COMMENTS_EMAIL_SECRET);
  assert.notEqual(first.emailEncrypted, duplicate.emailEncrypted);
  for (const [index, comment] of [first, second, duplicate].entries()) {
    const result = await appendApprovedComment({ root: clones[index], envelope: envelope(comment), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now });
    pushComment({ cwd: clones[index], file: result.relative, branch: 'master' });
  }
  git(clones[0], ['pull', '--rebase', 'origin', 'master']);
  assert.equal((await readdir(path.join(clones[0], 'content', directory, 'comments'))).length, 2);
  assert.equal(git(clones[0], ['log', '--format=%s']).toString().trim().split('\n').length, 3, '重复审批不产生重复提交');
  assert.equal(JSON.parse(await readFile(path.join(clones[0], commentFile(directory, first.id)), 'utf8')).emailEncrypted, first.emailEncrypted, '重复审批的随机密文冲突应保留已发布版本');
});

test('optional email is validated, canonicalized and bound to turnstileToken without exposing it in challenges', async () => {
  assert.deepEqual(validateComment({ ...input, email: '  ' }), validateComment(input));
  assert.equal(validateComment({ ...input, email: ' Reader+comments@EXAMPLE.ORG ' }).email, 'Reader+comments@example.org');
  const noNetwork = async () => assert.fail('invalid email or turnstileToken must not send email');
  for (const email of [null, 42, 'not-an-email', 'a@b@c.org', 'a@example.org\r\nBcc: x@example.org', 'a@-example.org', 'x'.repeat(65) + '@example.org']) {
    assert.equal((await handleSubmission(challengeRequest({ ...input, email }), deps())).status, 400);
    assert.equal((await handleSubmission(request({ ...input, email }), deps({ fetchImpl: noNetwork }))).status, 400);
  }
  const body = { ...input, email: 'reader@example.org' };
  const response = await handleSubmission(challengeRequest(body), deps());
  const task = await response.json();
  assert.equal(response.status, 200);
  assert.ok(!JSON.stringify(task).includes(body.email));
  const turnstileToken = solve(task);
  const emails = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const submitted = await handleSubmission(request({ ...body, turnstileToken }), deps({ fetchImpl: async (_, options) => {
      emails.push(options);
      return Response.json({ id: 'moderation-receipt' });
    } }));
    assert.equal(submitted.status, 202);
    assert.ok(!(await submitted.text()).includes(body.email));
  }
  assert.equal(emails[0].body, emails[1].body, '含邮箱的重复提交也应保持审核邮件幂等');
  const token = JSON.parse(emails[0].body).text.match(/#token=([\w.-]+)/)[1];
  assert.equal(readApproval(token, env.COMMENTS_APPROVAL_SECRET, new URL(env.COMMENTS_SITE_URL), now).comment.email, body.email);
  for (const email of [undefined, '', 'other@example.org']) assert.equal((await handleSubmission(request({ ...body, email, turnstileToken }), deps({ fetchImpl: noNetwork }))).status, 403);
  assert.equal((await handleSubmission(challengeRequest(body), deps({ env: { ...env, COMMENTS_EMAIL_SECRET: '' } }))).status, 503);
});

test('email encryption authenticates its comment and publishing cannot write plaintext or overwrite a different email', async () => {
  const body = { ...input, email: 'reader@example.org' };
  const stored = sealComment(body, env.COMMENTS_EMAIL_SECRET);
  assert.equal(stored.email, undefined);
  assert.ok(!JSON.stringify(stored).includes(body.email));
  assert.equal(openCommentEmail(stored, env.COMMENTS_EMAIL_SECRET), body.email);
  assert.equal(openCommentEmail(claim().comment, ''), undefined);
  const tampered = stored.emailEncrypted.slice(0, 3) + (stored.emailEncrypted[3] === 'A' ? 'B' : 'A') + stored.emailEncrypted.slice(4);
  for (const changed of [{ ...stored, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321' }, { ...stored, path: '/p/other/' }, { ...stored, emailHash: '0'.repeat(64) }, { ...stored, emailEncrypted: tampered }]) {
    assert.throws(() => openCommentEmail(changed, env.COMMENTS_EMAIL_SECRET));
  }
  assert.throws(() => openCommentEmail(stored, 'wrong-secret'.repeat(5)));
  assert.throws(() => validateStoredComment({ ...stored, email: body.email }));
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-email-'));
  await seedArticle(root);
  const publish = comment => appendApprovedComment({ root, envelope: envelope(comment), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now });
  await assert.rejects(publish(validateComment(body)), /明文邮箱/);
  await publish(stored);
  assert.equal((await publish(sealComment(body, env.COMMENTS_EMAIL_SECRET))).created, false);
  await assert.rejects(publish(sealComment({ ...body, email: 'different@example.org' }, env.COMMENTS_EMAIL_SECRET)), /拒绝覆盖/);
  assert.equal(JSON.parse(await readFile(path.join(root, commentFile(directory, body.id)), 'utf8')).emailEncrypted, stored.emailEncrypted);
});

function notificationFixture(email = 'reply-author@example.org', parentEmail = 'parent-author@example.org') {
  const parent = sealComment({ ...input, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321', email: parentEmail }, env.COMMENTS_EMAIL_SECRET);
  const comment = { ...input, email, parentId: parent.id };
  const signedClaim = approvalClaim(comment, { title: '<文章标题>' }, new URL(env.COMMENTS_SITE_URL), now);
  const token = sign(signedClaim, env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1');
  const pageList = async () => [{ ...(await pages())[0], commentIds: [parent.id], notificationEmails: parent.emailEncrypted ? { [parent.id]: { emailEncrypted: parent.emailEncrypted, emailHash: parent.emailHash } } : {} }];
  return { comment, parent, token, pageList };
}

test('approval sends two private notifications only after successful dispatch and never publishes plaintext email', async () => {
  const fixture = notificationFixture();
  const calls = [];
  let stored;
  const response = await handleSubmission(request({ action: 'approve', token: fixture.token, to: 'attacker@example.org' }), deps({ pages: fixture.pageList, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.github.com/')) {
      stored = verify(JSON.parse(options.body).inputs.envelope, env.COMMENTS_WORKFLOW_SECRET, 'comment-publish-v1').comment;
      assert.equal(stored.email, undefined);
      assert.equal(openCommentEmail(stored, env.COMMENTS_EMAIL_SECRET), fixture.comment.email);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(calls.length, 1, 'GitHub 尚未接受任务时不能发送通知');
      return new Response(null, { status: 204 });
    }
    assert.ok(stored);
    return Response.json({ id: 'notification-id' });
  } }));
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.deepEqual(result.notifications, { sent: 2, failed: 0 });
  assert.equal(result.notificationToken, undefined);
  assert.equal(calls.length, 3);
  const emails = calls.slice(1).map(call => JSON.parse(call.options.body));
  assert.deepEqual(emails.map(email => email.to), [['reply-author@example.org'], ['parent-author@example.org']]);
  assert.match(emails[0].subject, /通过审核/);
  assert.match(emails[1].subject, /收到了回复/);
  for (const email of emails) {
    assert.match(email.html, /&lt;script&gt;/);
    assert.doesNotMatch(email.html, /<script>|#token=|reply-author@example|parent-author@example/);
    assert.ok(email.text.includes(`#comment-${fixture.comment.id}`));
    assert.match(email.text, /构建和部署成功后/);
  }
  const noMail = async url => {
    assert.ok(url.startsWith('https://api.github.com/'));
    return new Response(null, { status: 502 });
  };
  assert.equal((await handleSubmission(request({ action: 'approve', token: fixture.token }), deps({ pages: fixture.pageList, fetchImpl: noMail }))).status, 502);
  assert.equal((await handleSubmission(request({ action: 'preview', token: fixture.token }), deps({ fetchImpl: async () => assert.fail() }))).status, 200);
});

test('notification failures can be retried without dispatching or resending successful messages', async () => {
  const fixture = notificationFixture();
  const calls = [];
  const response = await handleSubmission(request({ action: 'approve', token: fixture.token }), deps({ pages: fixture.pageList, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 204 });
    return JSON.parse(options.body).to[0] === fixture.comment.email ? Response.json({ id: 'accepted' }) : new Response('private upstream error', { status: 503 });
  } }));
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.deepEqual(result.notifications, { sent: 1, failed: 1 });
  assert.ok(result.notificationToken);
  assert.doesNotMatch(JSON.stringify(result), /private upstream|parent-author@example|reply-author@example/);
  const retries = [];
  const retried = await handleSubmission(request({ action: 'notify', token: fixture.token, notificationToken: result.notificationToken }), deps({ pages: async () => assert.fail('retry uses signed original recipients'), fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    retries.push(options);
    return Response.json({ id: 'accepted' });
  } }));
  assert.equal(retried.status, 202);
  assert.deepEqual((await retried.json()).notifications, { sent: 1, failed: 0 });
  assert.equal(retries.length, 1);
  assert.deepEqual(JSON.parse(retries[0].body).to, ['parent-author@example.org']);
  const failed = calls.find(call => call.url.endsWith('/emails') && JSON.parse(call.options.body).to[0] === 'parent-author@example.org');
  assert.equal(retries[0].body, failed.options.body);
  assert.equal(retries[0].headers['idempotency-key'], failed.options.headers['idempotency-key']);
  for (const notificationToken of [undefined, fixture.token, result.notificationToken.slice(0, -4) + 'xxxx']) {
    assert.equal((await handleSubmission(request({ action: 'notify', token: fixture.token, notificationToken }), deps({ fetchImpl: async () => assert.fail() }))).status, 400);
  }
  assert.equal((await handleSubmission(request({ action: 'notify', token: approval(), notificationToken: result.notificationToken }), deps({ fetchImpl: async () => assert.fail() }))).status, 400);
  assert.equal((await handleSubmission(request({ action: 'notify', token: fixture.token, notificationToken: result.notificationToken }), deps({ now: now + 86400000, fetchImpl: async () => assert.fail() }))).status, 400);
});

test('notification opt-outs and self-replies skip unwanted mail; unreadable parent emails remain retryable', async () => {
  for (const [email, parentEmail, expected] of [[undefined, undefined, []], [undefined, 'parent@example.org', ['parent@example.org']], ['author@example.org', undefined, ['author@example.org']], ['same@example.org', 'same@example.org', ['same@example.org']]]) {
    const fixture = notificationFixture(email || '', parentEmail || '');
    const recipients = [];
    const response = await handleSubmission(request({ action: 'approve', token: fixture.token }), deps({ pages: fixture.pageList, fetchImpl: async (url, options) => {
      if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 204 });
      recipients.push(...JSON.parse(options.body).to);
      return Response.json({ id: 'accepted' });
    } }));
    assert.equal(response.status, 202);
    assert.deepEqual(recipients, expected);
  }
  const fixture = notificationFixture('', 'parent@example.org');
  const response = await handleSubmission(request({ action: 'approve', token: fixture.token }), deps({ pages: fixture.pageList, env: { ...env, COMMENTS_EMAIL_SECRET: '' }, fetchImpl: async url => {
    assert.ok(url.startsWith('https://api.github.com/'));
    return new Response(null, { status: 204 });
  } }));
  assert.deepEqual((await response.json()).notifications, { sent: 0, failed: 1 });
});

test('comment workflow needs one configured secret and only verifies, commits and pushes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish-comment.yml', import.meta.url), 'utf8');
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['COMMENTS_SECRET', 'COMMENTS_WORKFLOW_SECRET'], '主密钥可单独工作，旧发布密钥仅供兼容');
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /COMMENT_FILE: \$\{\{ steps\.comment\.outputs\.comment_file \}\}/);
  assert.match(workflow, /COMMENTS_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /node scripts\/publish-comment\.mjs/);
  assert.match(workflow, /node scripts\/push-comment\.mjs/);
  assert.doesNotMatch(workflow, /npm\s|hugo|comments-deploy|DEPLOY_HOOK|inputs\.envelope|git push.*--force/);
});

test('publishing CLIs run without npm dependencies or deploy credentials and duplicate retries add no commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-cli-'));
  const remote = path.join(root, 'remote.git');
  const checkout = path.join(root, 'checkout');
  const branch = 'comments-test';
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git(root, ['init', '--bare', `--initial-branch=${branch}`, remote]);
  git(root, ['clone', remote, checkout]);
  git(checkout, ['config', 'user.name', 'Test']);
  git(checkout, ['config', 'user.email', 'test@example.org']);
  // Only source files: deliberately no node_modules, credentials, or built site.
  for (const file of ['package.json', 'server/comments/core.js', 'server/comments/storage.js', 'scripts/publish-comment.mjs', 'scripts/push-comment.mjs']) {
    await mkdir(path.dirname(path.join(checkout, file)), { recursive: true });
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(checkout, file));
  }
  await seedArticle(checkout);
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '-m', 'init']);
  git(checkout, ['push', 'origin', branch]);
  const created = Date.now();
  const comment = { ...claim().comment, createdAt: new Date(created).toISOString() };
  const event = path.join(root, 'event.json');
  const output = path.join(root, 'output');
  const signed = sign({ v: 1, repository: 'owner/blog', directory, comment, approvedAt: comment.createdAt, expiresAt: created + APPROVAL_TTL }, commentSecret(masterEnv, 'workflow'), 'comment-publish-v1');
  await writeFile(event, JSON.stringify({ inputs: { envelope: signed } }));
  const cliEnv = {
    PATH: process.env.PATH, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'owner/blog',
    COMMENTS_SECRET: masterEnv.COMMENTS_SECRET,
  };
  const run = (script, variables) => execFileSync(process.execPath, [script], { cwd: checkout, env: variables, stdio: 'pipe' });
  assert.throws(() => run('scripts/publish-comment.mjs', { ...cliEnv, COMMENTS_SECRET: '' }));
  assert.equal(git(checkout, ['status', '--porcelain']).trim(), '', 'missing signature secret must not write comments');
  for (let attempt = 0; attempt < 2; attempt++) {
    await writeFile(output, '');
    run('scripts/publish-comment.mjs', cliEnv);
    const values = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').map(line => line.split('=')));
    assert.equal(values.comment_file, commentFile(directory, comment.id));
    run('scripts/push-comment.mjs', { PATH: process.env.PATH, COMMENT_FILE: values.comment_file, COMMENTS_BRANCH: branch });
  }
  assert.deepEqual(JSON.parse(git(remote, ['show', `${branch}:${commentFile(directory, comment.id)}`])), comment);
  assert.equal(git(remote, ['rev-list', '--count', branch]).trim(), '2', 'init plus one comment commit');
  assert.equal(git(checkout, ['status', '--porcelain']).trim(), '');
});

test('nested replies retain their parent through turnstileToken, email, approval and article-local publishing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-replies-'));
  await seedArticle(root);
  const ids = [];
  const replyPages = async () => [{ ...(await pages())[0], commentIds: [...ids] }];
  for (let depth = 0; depth < 5; depth++) {
    const parentId = ids.at(-1);
    const body = { ...input, id: `fe251682-6cc0-40df-bf31-${String(depth).padStart(12, '0')}`, ...(parentId ? { parentId } : {}) };
    const task = await handleSubmission(challengeRequest(body), deps({ pages: replyPages }));
    assert.equal(task.status, 200);
    body.turnstileToken = solve(await task.json());
    if (parentId) await assert.rejects(verifyTurnstile(body.turnstileToken, validateComment({ ...body, parentId: input.id }), 'comment', new URL(env.COMMENTS_SITE_URL), env, mockSiteverify(), now), { status: 403 });
    let token;
    const submitted = await handleSubmission(request(body), deps({ pages: replyPages, fetchImpl: async (_, options) => {
      const email = JSON.parse(options.body);
      if (parentId) {
        assert.ok(email.text.includes(`#comment-${parentId}`));
        assert.ok(email.html.includes(`#comment-${parentId}`));
      }
      token = email.text.match(/#token=([\w.-]+)/)[1];
      return Response.json({ id: 'receipt' });
    } }));
    assert.equal(submitted.status, 202);
    const preview = await handleSubmission(request({ action: 'preview', token }), deps());
    assert.equal((await preview.json()).comment.parentId, parentId);
    const approved = await handleSubmission(request({ action: 'approve', token, directory: 'post/attacker' }), deps({ pages: replyPages, fetchImpl: async (_, options) => {
      const signed = JSON.parse(options.body).inputs.envelope;
      const result = await appendApprovedComment({ root, envelope: signed, secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now });
      assert.equal(result.relative, commentFile(directory, body.id));
      assert.deepEqual(JSON.parse(await readFile(path.join(root, result.relative), 'utf8')), validateComment(body));
      return new Response(null, { status: 204 });
    } }));
    assert.equal(approved.status, 202);
    ids.push(body.id);
  }
});

test('invalid, missing, self and foreign parents fail before email or workflow dispatch', async () => {
  const noNetwork = async () => assert.fail('invalid parent must not send email or dispatch');
  for (const parentId of [null, '', '../outside', 42, input.id, 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321']) {
    const body = { ...input, parentId };
    assert.equal((await handleSubmission(challengeRequest(body), deps())).status, 400);
    assert.equal((await handleSubmission(request(body), deps({ fetchImpl: noNetwork }))).status, 400);
  }
  const parentId = 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321';
  const body = { ...input, parentId };
  const foreignPages = async () => [...await pages(), { path: '/p/other/', title: '另一篇文章', directory: 'post/other', commentIds: [parentId] }];
  assert.equal((await handleSubmission(challengeRequest(body), deps({ pages: foreignPages }))).status, 400);
  const token = sign(approvalClaim(body, (await pages())[0], new URL(env.COMMENTS_SITE_URL), now), env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1');
  assert.equal((await handleSubmission(request({ action: 'approve', token }), deps({ fetchImpl: noNetwork }))).status, 400, '审批时父留言已删除应拒绝发布');
  assert.equal((await handleSubmission(request({ action: 'approve', token: approval() }), deps({ pages: async () => [], fetchImpl: noNetwork }))).status, 400);
});

test('publishing validates article directories, same-article parents, missing parents and cycles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-paths-'));
  await seedArticle(root);
  const publish = (comment, options = {}) => appendApprovedComment({ root, envelope: envelope(comment, options), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now });
  for (const invalid of [undefined, '', '../outside', 'post/../../outside', 'post/./example', '/post/example', 'post/example\nmalicious', 'post\\example']) {
    await assert.rejects(publish(claim().comment, { directory: invalid }));
    assert.throws(() => parseCommentFile(`content/${invalid}/comments/${input.id}.json`));
  }
  await assert.rejects(publish(claim().comment, { directory: 'post/missing' }));
  const parent = { ...claim().comment, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321' };
  const reply = { ...claim().comment, parentId: parent.id };
  await assert.rejects(publish(reply), /不存在/);
  await seedArticle(root, 'post/other');
  await publish(parent, { directory: 'post/other' });
  await assert.rejects(publish(reply), /不存在/);
  const parentFile = path.join(root, commentFile(directory, parent.id));
  await mkdir(path.dirname(parentFile), { recursive: true });
  await writeFile(parentFile, JSON.stringify({ ...parent, path: '/p/other/' }));
  await assert.rejects(publish(reply), /不属于/);
  await writeFile(parentFile, JSON.stringify({ ...parent, parentId: reply.id }));
  await assert.rejects(publish(reply), /循环/);
  await writeFile(parentFile, JSON.stringify({ ...parent, parentId: 'b380e8f6-0f53-4d32-a0a4-a48e4d2bc321' }));
  assert.equal((await publish(reply)).created, true, '祖先删除后仍可回复现存留言');
  await unlink(parentFile);
  await symlink(path.join(root, commentFile('post/other', parent.id)), parentFile);
  await assert.rejects(publish(reply), /无效/);
  await symlink(path.join(root, 'content', directory), path.join(root, 'content/post/link'));
  await assert.rejects(publish(claim().comment, { directory: 'post/link' }), /普通目录/);
});
