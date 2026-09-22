// HTTP 层：请求前置校验、JSON 读取与统一错误响应。
//
// security 约束：所有响应 no-store、no-referrer；错误 details 只
// 包含调用方显式附加的诊断字段，令牌、请求正文与环境变量不得进入。

import { Buffer } from 'node:buffer';
import { approvalClaim, CommentError, siteURL, validateCommentPage } from './core.js';

const MAX_BODY_BYTES = 26000;

export function json(status, body) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
  });
}

/** 业务错误转为响应；未知错误一律 503，不泄露内部信息。 */
export function failure(error) {
  return json(error instanceof CommentError ? error.status : 503, {
    error: error instanceof CommentError ? error.message : '评论服务暂时不可用，请稍后重试。',
    ...(error instanceof CommentError && error.details ? error.details : {}),
  });
}

/**
 * 前置校验：方法、同源、环境与内容类型。
 * Origin 不能单独当作反机器人机制，但能拦截跨站脚本提交。
 */
export function checkRequest(request, env, deployment) {
  if (request.method !== 'POST') throw new CommentError(405, '仅支持 POST 请求。');
  const site = siteURL(env.COMMENTS_SITE_URL);
  if (request.headers.get('origin') !== site.origin
    || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new CommentError(403, '请从本站提交。');
  }
  if (deployment !== 'production') throw new CommentError(503, '预览环境不发送评论或发布任务。');
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new CommentError(415, '请使用 JSON 提交。');
  }
  return site;
}

/** 读取并解析 JSON 请求体；限长（含流式计数），只接受对象。 */
export async function readJSON(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new CommentError(413, '提交内容过大。');
  if (!request.body) throw new CommentError(400, '提交内容为空。');
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CommentError(413, '提交内容过大。');
      }
      chunks.push(Buffer.from(value));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof CommentError) throw error;
    throw new CommentError(400, '提交内容格式不正确。');
  } finally {
    reader.releaseLock();
  }
}

/**
 * 校验评论提交：公开同意标记、隐藏诱捕字段、文章白名单。
 * 诱捕字段（website）对读者不可见，机器人填写即拒绝。
 */
export async function validateSubmission(input, site, now, pages) {
  if (input.consent !== true) throw new CommentError(400, '请先确认公开留言及 Git 历史记录说明。');
  if (typeof input.website !== 'string' || input.website) throw new CommentError(400, '评论未通过校验。');
  const page = (await pages()).find(page => page.path === input.path);
  if (!page) throw new CommentError(400, '此页面未开放评论。');
  const claim = approvalClaim(input, page, site, now);
  validateCommentPage(claim.comment, page);
  return claim;
}
