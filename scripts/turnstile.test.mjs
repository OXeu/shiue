import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSubmission } from '../server/submissions.js';
import { digest, validateComment } from '../server/comments/core.js';

const now = Date.parse('2026-09-18T12:00:00.000Z');
const env = {
  COMMENTS_SITE_URL: 'https://blog.example.org/', COMMENTS_SECRET: 'test-master-secret'.repeat(4),
  TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'private-turnstile-key',
  RESEND_API_KEY: 'private-resend-key', COMMENTS_EMAIL_FROM: 'blog@example.org', COMMENTS_EMAIL_TO: 'owner@example.org',
};
const input = { type: 'comment', action: 'submit', id: 'fe251682-6cc0-40df-bf31-6d48c12a985c', path: '/p/example/', name: '读者', message: '留言', email: 'reader@example.org', createdAt: new Date(now).toISOString(), consent: true, website: '', turnstileToken: 'opaque-provider-token' };
const request = (body = input) => new Request('https://blog.example.org/api/submissions', {
  method: 'POST', headers: { origin: 'https://blog.example.org', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const options = { env, now, deployment: 'production', pages: async () => [{ path: input.path, title: '文章', directory: 'post/example' }] };
const valid = () => ({ success: true, hostname: 'blog.example.org', action: 'comment', cdata: digest(validateComment(input)), challenge_ts: new Date(now).toISOString() });

test('submission verifies opaque tokens remotely, binds metadata and sends mail only after success', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (calls.length === 1) {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(init.body), { secret: env.TURNSTILE_SECRET_KEY, response: input.turnstileToken });
      assert.doesNotMatch(init.body, /reader@example|留言|remoteip/);
      return Response.json(valid());
    }
    assert.equal(url, 'https://api.resend.com/emails');
    return Response.json({ id: 'mail-receipt' });
  };
  const response = await handleSubmission(request(), { ...options, fetchImpl });
  assert.equal(response.status, 202);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(await response.text(), /opaque-provider-token|private-|reader@example/);
});

test('failed, expired, reused, mismatched and malformed provider results cannot send mail', async () => {
  const cases = [
    [{ success: false, 'error-codes': ['invalid-input-response'] }, 403],
    [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, 410],
    [{ success: false, 'error-codes': ['invalid-input-secret'] }, 503],
    [{ success: false, 'error-codes': ['internal-error'] }, 503],
    [{ ...valid(), success: 'true' }, 503], [null, 503], [{}, 503],
    ...[{ hostname: 'elsewhere.example.org' }, { action: 'friend' }, { cdata: 'changed' }, { cdata: undefined }, { challenge_ts: undefined }, { challenge_ts: 'invalid' }, { challenge_ts: new Date(now + 31000).toISOString() }].map(change => [{ ...valid(), ...change }, 403]),
    [{ ...valid(), challenge_ts: new Date(now - 300000).toISOString() }, 410],
  ];
  for (const [result, status] of cases) {
    let calls = 0;
    const response = await handleSubmission(request(), { ...options, fetchImpl: async url => {
      calls++;
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      return Response.json(result);
    } });
    assert.equal(response.status, status, JSON.stringify(result));
    assert.equal(calls, 1);
  }
});

test('network failures, redirects and invalid JSON fail closed without leaking upstream details', async () => {
  for (const reply of [
    () => new Response('private upstream failure', { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    () => new Response('<html>private upstream failure</html>'),
    () => { throw new Error('private upstream failure'); },
    () => { throw new DOMException('private timeout', 'TimeoutError'); },
  ]) {
    let calls = 0;
    const response = await handleSubmission(request(), { ...options, fetchImpl: async url => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      calls++;
      return reply();
    } });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
    assert.doesNotMatch(await response.text(), /private|<html>|evil/);
  }
});

test('replay is rejected by Siteverify; retry with a fresh token keeps the same email idempotency key', async () => {
  const consumed = new Set();
  const mails = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/siteverify')) {
      const { response } = JSON.parse(init.body);
      if (consumed.has(response)) return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      consumed.add(response);
      return Response.json(valid());
    }
    mails.push(init);
    return mails.length === 1 ? new Response(null, { status: 503 }) : Response.json({ id: 'mail-receipt' });
  };
  assert.equal((await handleSubmission(request(), { ...options, fetchImpl })).status, 502);
  assert.equal((await handleSubmission(request(), { ...options, fetchImpl })).status, 410);
  assert.equal((await handleSubmission(request({ ...input, turnstileToken: 'fresh-token' }), { ...options, fetchImpl })).status, 202);
  assert.equal(mails.length, 2);
  assert.equal(mails[0].body, mails[1].body);
  assert.equal(mails[0].headers['idempotency-key'], mails[1].headers['idempotency-key']);
});

test('missing configuration, malformed tokens and invalid forms do not call the provider', async () => {
  const fetchImpl = async () => assert.fail('unexpected external call');
  for (const extra of [{ TURNSTILE_SITE_KEY: '' }, { TURNSTILE_SECRET_KEY: '' }]) {
    for (const action of ['challenge', 'submit']) assert.equal((await handleSubmission(request({ ...input, action }), { ...options, env: { ...env, ...extra }, fetchImpl })).status, 503);
  }
  for (const turnstileToken of [undefined, null, {}, '', '   ', 'x'.repeat(2049)]) {
    assert.equal((await handleSubmission(request({ ...input, turnstileToken }), { ...options, fetchImpl })).status, 403);
  }
  assert.equal((await handleSubmission(request({ ...input, consent: false }), { ...options, fetchImpl })).status, 400);
});
