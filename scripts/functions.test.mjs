import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleSubmission as vercel } from '../api/submissions.js';
import netlify from '../netlify/functions/submissions.mjs';
import { onRequest as cloudflare } from '../functions/api/submissions.js';
import { commentSecret, verify } from '../server/comments/core.js';
import { openCommentEmail, sealComment } from '../server/comments/email.js';
import { readPages } from '../server/runtime/node.js';

const env = {
  COMMENTS_SITE_URL: 'https://blog.example.org/', COMMENTS_SECRET: 'function-adapter-test-only'.repeat(3),
  COMMENTS_POW_DIFFICULTY: '4', RESEND_API_KEY: 'test-resend',
  COMMENTS_EMAIL_FROM: 'Blog <blog@example.org>', COMMENTS_EMAIL_TO: 'owner@example.org',
  COMMENTS_GITHUB_TOKEN: 'test-github', COMMENTS_GITHUB_REPOSITORY: 'owner/blog',
};
const comment = () => ({ type: 'comment', id: randomUUID(), path: '/p/example/', name: '读者', message: '跨平台留言', email: 'reader@example.org', createdAt: new Date().toISOString(), website: '', consent: true });
const friend = () => ({ type: 'friend', id: randomUUID(), title: '朋友', website: 'https://friend.example.org/', description: '跨平台友链', icon: '', contact: '', createdAt: new Date().toISOString(), consent: true });
const request = (body, origin = env.COMMENTS_SITE_URL) => new Request(`${env.COMMENTS_SITE_URL}api/submissions`, {
  method: 'POST', headers: { origin: new URL(origin).origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const pageList = [{ path: '/p/example/', title: '文章', directory: 'post/example', commentIds: [] }];
function solve(task) {
  for (let nonce = 0; ; nonce++) if (createHash('sha256').update(task.challenge + nonce).digest('hex').startsWith('0'.repeat(task.difficulty))) return { token: task.token, nonce: String(nonce) };
}
function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
async function manifestDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-functions-'));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/comment-pages.json'), JSON.stringify(pageList));
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  return root;
}

test('all provider entries run challenge, moderation, preview, publishing and encrypted notifications', async t => {
  for (const provider of ['vercel', 'netlify', 'cloudflare']) await t.test(provider, async t => {
    setEnv(t, env);
    const root = await manifestDirectory(t);
    assert.deepEqual(await readPages(path.join(root, 'public/comment-pages.json')), pageList);
    let assetReads = 0;
    const assets = { fetch: async url => {
      assetReads++;
      assert.equal(url.href, 'https://blog.example.org/comment-pages.json');
      return Response.json(pageList);
    } };
    const invoke = body => {
      const req = request(body);
      if (provider === 'vercel') return vercel(req, { env: { ...env, VERCEL_ENV: 'production' }, pages: async () => pageList });
      if (provider === 'netlify') return netlify(req, { deploy: { context: 'production' } });
      return cloudflare({ request: req, env: { ...env, COMMENTS_ENV: 'production', ASSETS: assets } });
    };
    const mails = [];
    const published = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.redirect, 'manual');
      if (url === 'https://api.resend.com/emails') {
        mails.push(JSON.parse(init.body));
        return Response.json({ id: 'test-mail' });
      }
      assert.match(url, /^https:\/\/api.github.com\/repos\/owner\/blog\/actions\/workflows\/publish-(comment|friend).yml\/dispatches$/);
      const type = url.includes('publish-comment') ? 'comment' : 'friend';
      published.push(verify(JSON.parse(init.body).inputs.envelope, commentSecret(env, 'workflow'), `${type}-publish-v1`));
      return new Response(null, { status: 204 });
    });
    for (const input of [comment(), friend()]) {
      const challenge = await invoke({ ...input, action: 'challenge' });
      assert.equal(challenge.status, 200);
      assert.equal(challenge.headers.get('cache-control'), 'no-store');
      const proof = solve(await challenge.json());
      const submission = await invoke({ ...input, action: 'submit', proof });
      assert.equal(submission.status, 202);
      assert.doesNotMatch(await submission.text(), /token|secret|reader@example/);
      const token = mails.at(-1).text.match(/#token=([\w.-]+)/)[1];
      const previews = published.length;
      const preview = await invoke({ type: input.type, action: 'preview', token });
      assert.equal(preview.status, 200);
      assert.equal((await preview.json())[input.type].id, input.id);
      assert.equal(published.length, previews);
      const approved = await invoke({ type: input.type, action: 'approve', token });
      assert.equal(approved.status, 202);
      assert.equal(published.at(-1)[input.type].id, input.id);
    }
    assert.equal(mails.length, 3, 'two moderation emails and one comment approval notification');
    assert.equal(published[0].comment.email, undefined);
    assert.equal(openCommentEmail(published[0].comment, commentSecret(env, 'email')), 'reader@example.org');
    assert.equal(assetReads, provider === 'cloudflare' ? 3 : 0, 'only comment challenge, submit and approval read the asset');
  });
});

test('preview and unknown environments reject forged production origins before assets or external calls', async t => {
  setEnv(t, { ...env, COMMENTS_ENV: 'production' });
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('unexpected call'); };
  t.mock.method(globalThis, 'fetch', unexpected);
  for (const action of ['challenge', 'submit', 'preview', 'approve', 'notify']) {
    for (const deployment of ['preview', 'development', 'branch-deploy', 'deploy-preview']) {
      const body = { ...comment(), action };
      assert.equal((await vercel(request(body), { env: { ...env, VERCEL_ENV: deployment }, pages: unexpected })).status, 503);
      assert.equal((await netlify(request(body), { deploy: { context: deployment } })).status, 503);
      assert.equal((await cloudflare({ request: request(body), env: { ...env, COMMENTS_ENV: deployment, ASSETS: { fetch: unexpected } } })).status, 503);
    }
    assert.equal((await netlify(request({ ...comment(), action }), {})).status, 503);
    assert.equal((await cloudflare({ request: request({ ...comment(), action }), env: { ...env, ASSETS: { fetch: unexpected } } })).status, 503);
  }
  assert.equal(calls, 0);
});

test('Cloudflare uses its deployment assets and handles a missing or invalid whitelist without network fallback', async t => {
  const external = t.mock.method(globalThis, 'fetch', async () => assert.fail('no external fetch'));
  for (const response of [new Response('not found', { status: 404 }), new Response('<html>not JSON</html>'), Response.json({})]) {
    const result = await cloudflare({ request: request({ ...comment(), action: 'challenge' }), env: { ...env, COMMENTS_ENV: 'production', ASSETS: { fetch: async () => response } } });
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /<html>|test-resend/);
  }
  assert.equal(external.mock.callCount(), 0);
});

test('Netlify fails closed when the bundled whitelist is missing', async t => {
  setEnv(t, env);
  const root = await mkdtemp(path.join(tmpdir(), 'xeu-functions-missing-'));
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  const response = await netlify(request({ ...comment(), action: 'challenge' }), { deploy: { context: 'production' } });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /ENOENT|xeu-functions/);
});
