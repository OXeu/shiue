import { timingSafeEqual } from 'node:crypto';

// The cron only triggers the same production build; it never edits repository
// data or checks friends inside a short-lived serverless request.
export async function triggerDailyDeploy(request, { env = process.env, fetchImpl = fetch } = {}) {
  const reply = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (request.method !== 'GET') return reply(405, { error: 'Method not allowed' });
  if (!env.CRON_SECRET) return reply(503, { error: 'Daily deployment is not configured' });
  const actual = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: 'Unauthorized' });
  if (env.VERCEL_ENV !== 'production') return reply(409, { error: 'Daily deployment is production-only' });
  let hook;
  try {
    hook = new URL(env.VERCEL_DEPLOY_HOOK_URL);
    if (hook.origin !== 'https://api.vercel.com' || !/^\/v1\/integrations\/deploy\/[^/]+\/[^/]+$/.test(hook.pathname) || hook.username || hook.password) throw new Error();
  } catch { return reply(503, { error: 'Deploy hook is not configured correctly' }); }
  try {
    const response = await fetchImpl(hook.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    if (!response.ok) return reply(502, { error: 'Deploy hook rejected the request', status: response.status });
    return reply(202, { queued: true });
  } catch {
    // Never log the hook URL or an upstream error containing its secret token.
    return reply(502, { error: 'Deploy hook could not be reached' });
  }
}

export default { fetch: request => triggerDailyDeploy(request) };
