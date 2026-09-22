import { CommentError, digest } from './comments/core.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TTL = 5 * 60 * 1000;

function configuration(env) {
  if (typeof env.TURNSTILE_SITE_KEY !== 'string' || !/^[\w-]{1,100}$/.test(env.TURNSTILE_SITE_KEY) ||
      typeof env.TURNSTILE_SECRET_KEY !== 'string' || !env.TURNSTILE_SECRET_KEY.trim()) {
    throw new CommentError(503, '浏览器验证尚未配置完成。');
  }
}

export function turnstileChallenge(content, type, env) {
  configuration(env);
  return { provider: 'turnstile', sitekey: env.TURNSTILE_SITE_KEY, action: type, cData: digest(content) };
}

export async function verifyTurnstile(token, content, type, site, env, fetchImpl, now) {
  configuration(env);
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    throw new CommentError(403, '请重新完成浏览器验证后提交。');
  }
  let result;
  try {
    const response = await fetchImpl(SITEVERIFY, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' },
      // Do not send IP addresses or plaintext form fields to Siteverify.
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    result = await response.json();
    if (!result || typeof result.success !== 'boolean') throw new Error();
  } catch {
    throw new CommentError(503, '浏览器验证服务暂时不可用，请保留内容并重试。');
  }
  if (!result.success) {
    const errors = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
    if (errors.some(code => ['missing-input-secret', 'invalid-input-secret', 'internal-error', 'bad-request'].includes(code))) {
      throw new CommentError(503, '浏览器验证服务暂时不可用，请稍后重试。');
    }
    if (errors.includes('timeout-or-duplicate')) throw new CommentError(410, '浏览器验证已过期或已使用，请重新提交。');
    throw new CommentError(403, '浏览器验证未通过，请重新提交。');
  }
  if (result.hostname !== site.hostname || result.action !== type || result.cdata !== digest(content)) {
    throw new CommentError(403, '浏览器验证与本次提交不匹配，请重新提交。');
  }
  const solvedAt = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN;
  if (!Number.isFinite(solvedAt) || solvedAt > now + 30000) throw new CommentError(403, '浏览器验证时间无效，请重新提交。');
  if (solvedAt + TURNSTILE_TTL <= now) throw new CommentError(410, '浏览器验证已过期，请重新提交。');
}
