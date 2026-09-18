import { CommentError, digest, moderationEmail, requireSecret, sign } from '../server/comments/core.js';
import { checkRequest, failure, json, readPages, readSubmission } from '../server/comments/http.js';
import { verifyProof } from '../server/comments/pow.js';

export async function submitComment(request, { env = process.env, fetchImpl = fetch, pages = readPages, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    const { input, claim } = await readSubmission(request, site, now, pages);
    requireSecret(env.COMMENTS_APPROVAL_SECRET);
    if (!env.RESEND_API_KEY || !env.COMMENTS_EMAIL_FROM || !env.COMMENTS_EMAIL_TO) throw new CommentError(503, '评论服务尚未配置完成。');
    // Invalid proofs make no outbound calls; PoW is required even without a rate-limit service.
    verifyProof(input.proof, claim.comment, site, env, now);
    const token = sign(claim, env.COMMENTS_APPROVAL_SECRET, 'comment-approval-v1');
    const email = moderationEmail(claim, token, site, env.COMMENTS_EMAIL_FROM, env.COMMENTS_EMAIL_TO);
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `comment-${digest(email)}` },
      body: JSON.stringify(email),
    });
    if (!response.ok) { await response.body?.cancel(); throw new CommentError(502, '评论暂未送达，请保留内容并重试。'); }
    const result = await response.json();
    if (!result.id) throw new Error('missing email receipt');
    // 绝不能向提交者返回签名、审批链接或邮件内容，否则可以绕过审核。
    return json(202, { id: claim.comment.id, message: '评论已送交审核，通过并完成部署后会显示在这里。' });
  } catch (error) { return failure(error); }
}
export default { fetch: request => submitComment(request) };
