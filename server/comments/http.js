import { readFile } from 'node:fs/promises';
import { approvalClaim, CommentError, siteURL, validateCommentPage } from './core.js';

export function json(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
export function failure(error) {
  // 不将上游响应、令牌、邮件正文或环境变量写入日志 / 返回给访客。
  return json(error instanceof CommentError ? error.status : 503, { error: error instanceof CommentError ? error.message : '评论服务暂时不可用，请稍后重试。' });
}
export function checkRequest(request, env) {
  if (request.method !== 'POST') throw new CommentError(405, '仅支持 POST 请求。');
  const site = siteURL(env.COMMENTS_SITE_URL);
  if (request.headers.get('origin') !== site.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new CommentError(403, '请从本站提交。');
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') throw new CommentError(503, '预览环境不发送评论或发布任务。');
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new CommentError(415, '请使用 JSON 提交。');
  return site;
}
export async function readJSON(request) {
  const limit = 26000;
  if (Number(request.headers.get('content-length')) > limit) throw new CommentError(413, '提交内容过大。');
  if (!request.body) throw new CommentError(400, '提交内容为空。');
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new CommentError(413, '提交内容过大。'); }
      chunks.push(Buffer.from(value));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof CommentError) throw error;
    throw new CommentError(400, '提交内容格式不正确。');
  } finally { reader.releaseLock(); }
}
export async function readPages() {
  return JSON.parse(await readFile(new URL('../../public/comment-pages.json', import.meta.url), 'utf8'));
}
export async function readSubmission(request, site, now, pages = readPages) {
  const input = await readJSON(request);
  if (input.consent !== true) throw new CommentError(400, '请先确认公开留言及 Git 历史记录说明。');
  if (typeof input.website !== 'string' || input.website) throw new CommentError(400, '评论未通过校验。');
  const page = (await pages()).find(page => page.path === input.path);
  if (!page) throw new CommentError(400, '此页面未开放评论。');
  const claim = approvalClaim(input, page, site, now);
  validateCommentPage(claim.comment, page);
  return { input, claim };
}
