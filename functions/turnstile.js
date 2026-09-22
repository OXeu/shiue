// Cloudflare Turnstile 服务端验证。
//
// challenge 阶段只下发 sitekey 和绑定内容的摘要（cData），不请求
// Cloudflare；submit 阶段才调用 Siteverify 校验令牌，并核对 hostname、
// action、cData 与验证时间，防止令牌跨站、跨内容重放。

import { CommentError, digest } from './comments/core.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 验证令牌有效期（毫秒），与 Turnstile 官方默认一致。 */
export const TURNSTILE_TTL = 5 * 60 * 1000;

function configuration(env) {
  if (typeof env.TURNSTILE_SITE_KEY !== 'string' || !/^[\w-]{1,100}$/.test(env.TURNSTILE_SITE_KEY)
    || typeof env.TURNSTILE_SECRET_KEY !== 'string' || !env.TURNSTILE_SECRET_KEY.trim()) {
    throw new CommentError(503, '浏览器验证尚未配置完成。');
  }
}

/** challenge 响应：前端据此按需加载 Turnstile 组件。 */
export function turnstileChallenge(content, type, env) {
  configuration(env);
  return { provider: 'turnstile', sitekey: env.TURNSTILE_SITE_KEY, action: type, cData: digest(content) };
}

/**
 * 校验浏览器提交的 Turnstile 令牌。
 *
 * 不向 Siteverify 发送 IP 或明文表单字段；只有 secret 与 response。
 * 任何一步不匹配（域名、类型、内容摘要、时间窗）都以 403/410 拒绝，
 * 且不会区分具体原因，避免给重放者提供信息。
 */
export async function verifyTurnstile(token, content, type, site, env, fetchImpl, now) {
  configuration(env);
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    throw new CommentError(403, '请重新完成浏览器验证后提交。');
  }

  let result;
  try {
    const response = await fetchImpl(SITEVERIFY, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    result = await response.json();
    if (!result || typeof result.success !== 'boolean') throw new Error();
  } catch {
    // 网络故障或上游异常按服务不可用处理，让读者保留草稿重试。
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

  // 令牌必须绑定本次提交：域名、action、内容摘要三者一致。
  if (result.hostname !== site.hostname || result.action !== type || result.cdata !== digest(content)) {
    throw new CommentError(403, '浏览器验证与本次提交不匹配，请重新提交。');
  }
  // 验证时间必须在有效期内；允许 30 秒的服务端时钟偏差。
  const solvedAt = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN;
  if (!Number.isFinite(solvedAt) || solvedAt > now + 30000) throw new CommentError(403, '浏览器验证时间无效，请重新提交。');
  if (solvedAt + TURNSTILE_TTL <= now) throw new CommentError(410, '浏览器验证已过期，请重新提交。');
}
