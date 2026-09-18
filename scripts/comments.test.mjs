import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { challengeComment } from '../api/comments-challenge.js';
import { submitComment } from '../api/comments-submit.js';
import { approveComment } from '../api/comments-approve.js';
import { APPROVAL_TTL, approvalClaim, readApproval, sign, validateComment, verify } from '../server/comments/core.js';
import { issueProof, POW_TTL, powDifficulty, verifyProof } from '../server/comments/pow.js';
import { appendApprovedComment } from './publish-comment.mjs';
import { pushComment } from './push-comment.mjs';
import { deployComments, deployHook } from './comments-deploy.mjs';

const now = Date.parse('2026-09-17T20:00:00.000Z');
const env = {
  COMMENTS_SITE_URL: 'https://blog.example.org/', COMMENTS_APPROVAL_SECRET: 'a'.repeat(64), COMMENTS_WORKFLOW_SECRET: 'b'.repeat(64),
  RESEND_API_KEY: 'resend-test-secret', COMMENTS_EMAIL_FROM: 'Blog <blog@example.org>', COMMENTS_EMAIL_TO: 'owner@example.org',
  COMMENTS_GITHUB_TOKEN: 'github-test-secret', COMMENTS_GITHUB_REPOSITORY: 'owner/blog', COMMENTS_GITHUB_BRANCH: 'master',
  COMMENTS_POW_SECRET: 'c'.repeat(64), COMMENTS_POW_DIFFICULTY: '4',
};
const input = { id: 'fe251682-6cc0-40df-bf31-6d48c12a985c', path: '/p/example/', name: '读者', message: '第一行\n<script>alert(1)</script> ${{ secrets.TOKEN }} $(echo unsafe)', createdAt: new Date(now).toISOString(), website: '', consent: true };
const pages = async () => [{ path: input.path, title: '文章标题 <test>' }];
const deps = extra => ({ env, now, pages, ...extra });
const request = (data, headers = {}, method = 'POST') => new Request('https://blog.example.org/api/comments-submit', { method, headers: { origin: 'https://blog.example.org', 'content-type': 'application/json', ...headers }, ...(method !== 'GET' ? { body: JSON.stringify(data) } : {}) });
const claim = () => approvalClaim(input, { title: '文章标题' }, new URL(env.COMMENTS_SITE_URL), now);
const approval = () => sign(claim(), env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1');
const envelope = (comment = claim().comment, options = {}) => sign({ v: 1, repository: 'owner/blog', comment, approvedAt: new Date(now).toISOString(), expiresAt: now + APPROVAL_TTL, ...options }, env.COMMENTS_WORKFLOW_SECRET, 'comment-publish-v1');
function solve(task) {
  for (let nonce = 0; ; nonce++) {
    if (createHash('sha256').update(task.challenge + nonce).digest('hex').startsWith('0'.repeat(task.difficulty))) return { token: task.token, nonce: String(nonce) };
  }
}
input.proof = solve(issueProof(validateComment(input), new URL(env.COMMENTS_SITE_URL), env, now));

test('challenge endpoint validates input and signs a bounded random puzzle without firewall configuration', async () => {
  const challenges = [];
  for (let i = 0; i < 2; i++) {
    const response = await challengeComment(request(input), deps());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const task = await response.json();
    assert.equal(task.expiresAt, now + POW_TTL);
    assert.equal(task.algorithm, 'sha256');
    assert.equal(task.difficulty, 4);
    assert.match(task.challenge, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(task), /resend-test|github-test|owner@example|读者|<script>/);
    challenges.push(task.challenge);
  }
  assert.notEqual(challenges[0], challenges[1]);
  for (const [body, status] of [[{ ...input, consent: false }, 400], [{ ...input, website: 'spam' }, 400], [{ ...input, path: '/not-enabled/' }, 400], [{ ...input, message: 'x'.repeat(27000) }, 413]]) {
    assert.equal((await challengeComment(request(body), deps())).status, status);
  }
  for (const [extra, status] of [
    [{ COMMENTS_POW_SECRET: '' }, 503], [{ COMMENTS_POW_DIFFICULTY: '0' }, 503], [{ VERCEL_ENV: 'preview' }, 503],
  ]) assert.equal((await challengeComment(request(input), deps({ env: { ...env, ...extra } }))).status, status);
  assert.equal((await challengeComment(request(input, {}, 'GET'), deps())).status, 405);
  assert.equal((await challengeComment(request(input, { origin: 'https://evil.example' }), deps())).status, 403);
});

test('proofs bind canonical comment and site; tampering, changed difficulty, missing proof and invalid nonce fail before network', async () => {
  const valid = validateComment(input);
  const site = new URL(env.COMMENTS_SITE_URL);
  verifyProof(input.proof, valid, site, env, now);
  assert.equal(powDifficulty({}), 5);
  for (const value of ['0', '3', '7', '-1', '4.5', '', '04', 'NaN']) assert.throws(() => powDifficulty({ COMMENTS_POW_DIFFICULTY: value }));
  const claim = verify(input.proof.token, env.COMMENTS_POW_SECRET, 'comment-pow-v1');
  const tampered = Buffer.from(JSON.stringify({ ...claim, difficulty: 0 })).toString('base64url') + '.' + input.proof.token.split('.')[1];
  const wrongNonce = (() => {
    for (let n = 0; ; n++) if (!createHash('sha256').update(claim.challenge + n).digest('hex').startsWith('0000')) return String(n);
  })();
  const bad = [undefined, {}, { ...input.proof, nonce: wrongNonce }, { ...input.proof, token: tampered }, { ...input.proof, token: approval() },
    ...[-1, 0, 1.5, '01', '-1', '1e2', '1.0', '9007199254740992', 'x'.repeat(2000)].map(nonce => ({ ...input.proof, nonce }))];
  const noNetwork = async () => assert.fail('invalid proofs must not make outbound calls');
  for (const proof of bad) assert.equal((await submitComment(request({ ...input, proof }), deps({ fetchImpl: noNetwork }))).status, 403);
  for (const change of [{ id: 'ae251682-6cc0-40df-bf31-6d48c12a985c' }, { name: 'someone else' }, { message: 'different' }, { createdAt: new Date(now + 1).toISOString() }, { path: '/p/another/' }]) {
    assert.throws(() => verifyProof(input.proof, { ...valid, ...change }, site, env, now), { status: 403 });
  }
  assert.throws(() => verifyProof(input.proof, valid, new URL('https://other.example/'), env, now), { status: 403 });
  assert.throws(() => verifyProof(input.proof, valid, site, { ...env, COMMENTS_POW_DIFFICULTY: '5' }, now), { status: 403 });
  assert.throws(() => verifyProof(input.proof, valid, site, { ...env, COMMENTS_POW_SECRET: 'd'.repeat(64) }, now), { status: 403 });
  assert.throws(() => verifyProof(input.proof, valid, site, { ...env, COMMENTS_POW_SECRET: '' }, now), { status: 503 });
  assert.throws(() => verifyProof(input.proof, valid, site, env, now - 60000), { status: 403 });
  assert.equal((await submitComment(request(input), deps({ now: now + POW_TTL, fetchImpl: noNetwork }))).status, 410);
});

test('submission sends escaped details to a fixed recipient; approval capability never reaches the visitor', async () => {
  let sent;
  const response = await submitComment(request({ ...input, title: '伪造标题', to: 'attacker@example.org' }), deps({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.redirect, 'error');
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
  await submitComment(request(input), deps({ fetchImpl }));
  await submitComment(request(input), deps({ fetchImpl, now: now + 60000 }));
  const proof = solve(issueProof(validateComment(input), new URL(env.COMMENTS_SITE_URL), env, now + POW_TTL));
  await submitComment(request({ ...input, proof }), deps({ fetchImpl, now: now + POW_TTL }));
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
  assert.equal(requests[0].headers['idempotency-key'], requests[2].headers['idempotency-key'], 'renewing a challenge must not change email idempotency');
});

test('full production-config flow without rate-limit settings: challenge → email → preview → dispatch → file', async t => {
  const production = { ...env, VERCEL: '1', VERCEL_ENV: 'production' };
  const realFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected outbound call'); });
  const calls = [];
  let token;
  const challenge = await challengeComment(request(input), deps({ env: production }));
  assert.equal(challenge.status, 200);
  const proof = solve(await challenge.json());
  const submitted = await submitComment(request({ ...input, proof }), deps({ env: production, fetchImpl: async (url, options) => {
    calls.push(url);
    token = JSON.parse(options.body).text.match(/#token=([\w.-]+)/)[1];
    return Response.json({ id: 'email-id' });
  } }));
  assert.equal(submitted.status, 202);
  const preview = await approveComment(request({ action: 'preview', token }), deps({ env: production }));
  assert.equal(preview.status, 200);
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-flow-'));
  let file;
  const approved = await approveComment(request({ action: 'approve', token }), deps({ env: production, fetchImpl: async (url, options) => {
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
  for (const body of invalid) assert.equal((await submitComment(request(body), deps({ fetchImpl: noEmail }))).status, 400);
  assert.equal((await submitComment(request(input, { origin: 'https://evil.example' }), deps({ fetchImpl: noEmail }))).status, 403);
  assert.equal((await submitComment(request(input, { 'sec-fetch-site': 'cross-site' }), deps({ fetchImpl: noEmail }))).status, 403);
  assert.equal((await submitComment(request(input, { 'content-type': 'text/plain' }), deps({ fetchImpl: noEmail }))).status, 415);
  assert.equal((await submitComment(request({}, {}, 'GET'), deps({ fetchImpl: noEmail }))).status, 405);
  assert.equal((await submitComment(request({ ...input, padding: 'x'.repeat(27000) }), deps({ fetchImpl: noEmail }))).status, 413);
  assert.equal((await submitComment(request(input), deps({ fetchImpl: noEmail, env: { ...env, RESEND_API_KEY: '' } }))).status, 503);
  assert.equal((await submitComment(request(input), deps({ fetchImpl: noEmail, env: { ...env, VERCEL_ENV: 'preview' } }))).status, 503);
  const malformed = new Request('https://blog.example.org/api/comments-submit', { method: 'POST', headers: { origin: 'https://blog.example.org', 'content-type': 'application/json' }, body: '{' });
  assert.equal((await submitComment(malformed, deps({ fetchImpl: noEmail }))).status, 400);
});

test('upstream failures remain recoverable without disclosing credentials', async () => {
  for (const fetchImpl of [async () => new Response('secret', { status: 429 }), async () => { throw new Error(env.RESEND_API_KEY); }, async () => Response.json({})]) {
    const response = await submitComment(request(input), deps({ fetchImpl }));
    assert.ok(response.status >= 500);
    assert.doesNotMatch(await response.text(), /resend-test-secret|github-test-secret/);
  }
});

test('GET / preview cannot publish; confirmation dispatches a separately signed workflow payload', async () => {
  const noDispatch = async () => assert.fail('must not dispatch');
  assert.equal((await approveComment(request({}, {}, 'GET'), deps({ fetchImpl: noDispatch }))).status, 405);
  const preview = await approveComment(request({ action: 'preview', token: approval() }), deps({ fetchImpl: noDispatch }));
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).comment.name, input.name);
  let dispatched;
  const response = await approveComment(request({ action: 'approve', token: approval(), repository: 'attacker/repo' }), deps({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/owner/blog/actions/workflows/publish-comment.yml/dispatches');
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

test('tampered, expired and cross-site approvals cannot dispatch; GitHub errors stay recoverable', async () => {
  const noDispatch = async () => assert.fail();
  for (const token of ['not-a-token', `${approval().slice(0, 8)}X${approval().slice(9)}`, envelope()]) {
    assert.equal((await approveComment(request({ action: 'approve', token }), deps({ fetchImpl: noDispatch }))).status, 400);
  }
  assert.equal((await approveComment(request({ action: 'approve', token: approval() }), deps({ now: now + APPROVAL_TTL, fetchImpl: noDispatch }))).status, 410);
  assert.equal((await approveComment(request({ action: 'approve', token: approval() }, { origin: 'https://evil.example' }), deps({ fetchImpl: noDispatch }))).status, 403);
  assert.equal((await approveComment(request({ action: 'approve', token: approval() }), deps({ fetchImpl: async () => new Response('', { status: 401 }) }))).status, 502);
});

test('approved comments use exclusive UUID files, reject overwrites, preserve text, and require workflow signature', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-comments-data-'));
  const options = { root, envelope: envelope(), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now };
  const result = await appendApprovedComment(options);
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, result.relative), 'utf8')), claim().comment);
  assert.equal((await appendApprovedComment(options)).created, false);
  await assert.rejects(appendApprovedComment({ ...options, envelope: envelope({ ...claim().comment, message: 'changed' }) }), /拒绝覆盖/);
  await assert.rejects(appendApprovedComment({ ...options, envelope: approval() }));
  await assert.rejects(appendApprovedComment({ ...options, repository: 'other/repo' }));
  await assert.rejects(appendApprovedComment({ ...options, now: now + APPROVAL_TTL }));
  await assert.rejects(appendApprovedComment({ ...options, envelope: envelope({ ...claim().comment, id: '../../outside' }) }));
  assert.equal((await readdir(path.join(root, 'data/comments'))).length, 1);
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
  git(clones[0], ['add', 'README.md']); git(clones[0], ['commit', '-m', 'init']); git(clones[0], ['push', 'origin', 'master']);
  for (const clone of clones.slice(1)) git(clone, ['pull', 'origin', 'master']);
  const first = claim().comment;
  const second = { ...first, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321', message: '另一条评论' };
  for (const [index, comment] of [first, second, first].entries()) {
    const result = await appendApprovedComment({ root: clones[index], envelope: envelope(comment), secret: env.COMMENTS_WORKFLOW_SECRET, repository: 'owner/blog', now });
    pushComment({ cwd: clones[index], file: result.relative, branch: 'master' });
  }
  git(clones[0], ['pull', '--rebase', 'origin', 'master']);
  assert.equal((await readdir(path.join(clones[0], 'data/comments'))).length, 2);
  assert.equal(git(clones[0], ['log', '--format=%s']).toString().trim().split('\n').length, 3, '重复审批不产生重复提交');
});

test('deploy only uses validated Vercel hooks and propagates failures', async () => {
  const hook = 'https://api.vercel.com/v1/integrations/deploy/project/token';
  assert.equal(deployHook(hook), hook);
  for (const invalid of ['https://evil.example/deploy', 'http://api.vercel.com/v1/integrations/deploy/a/b', `${hook}?extra=true`]) assert.throws(() => deployHook(invalid));
  let called = false;
  await deployComments({ hook, fetchImpl: async (url, options) => { called = true; assert.equal(url, hook); assert.equal(options.method, 'POST'); return new Response('', { status: 201 }); } });
  assert.ok(called);
  await assert.rejects(deployComments({ hook, fetchImpl: async () => new Response('', { status: 500 }) }));
});
