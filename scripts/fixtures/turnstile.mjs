import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Test-only opaque tokens. Production always sends tokens to Cloudflare.
export function fixtureToken(task, now = Date.now(), hostname = 'blog.example.org') {
  return Buffer.from(JSON.stringify({
    success: true, hostname, action: task.action, cdata: task.cData,
    challenge_ts: new Date(now).toISOString(), id: randomUUID(),
  })).toString('base64url');
}

export function mockSiteverify(next = async () => assert.fail('unexpected external request')) {
  return async (url, init) => {
    if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return next(url, init);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['response', 'secret']);
    assert.ok(body.secret);
    try { return Response.json(JSON.parse(Buffer.from(body.response, 'base64url').toString())); }
    catch { return Response.json({ success: false, 'error-codes': ['invalid-input-response'] }); }
  };
}
