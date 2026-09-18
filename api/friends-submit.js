import { CommentError, commentSecret, digest, sign } from '../server/comments/core.js';
import { checkRequest, json } from '../server/comments/http.js';
import { verifyProof } from '../server/comments/pow.js';
import { APPROVAL_PURPOSE, friendEmail, POW_PURPOSE } from '../server/friends/core.js';
import { friendFailure, readFriendSubmission } from '../server/friends/http.js';

export async function submitFriend(request, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    const { input, claim } = await readFriendSubmission(request, site, now);
    const approvalSecret = commentSecret(env, 'approval');
    if (!env.RESEND_API_KEY || !env.COMMENTS_EMAIL_FROM || !env.COMMENTS_EMAIL_TO) throw new CommentError(503, '友链申请服务尚未配置完成。');
    verifyProof(input.proof, claim.friend, site, env, now, POW_PURPOSE);
    const token = sign(claim, approvalSecret, APPROVAL_PURPOSE);
    const email = friendEmail(claim, token, site, env.COMMENTS_EMAIL_FROM, env.COMMENTS_EMAIL_TO);
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `friend-${digest(email)}` },
      body: JSON.stringify(email),
    });
    if (!response.ok) { await response.body?.cancel(); throw new CommentError(502, '申请暂未送达，请保留内容并重试。'); }
    if (!(await response.json()).id) throw new Error('missing email receipt');
    return json(202, { id: claim.friend.id, message: '友链申请已送交审核，通过并完成部署后会显示在友链列表中。' });
  } catch (error) { return friendFailure(error); }
}
export default { fetch: request => submitFriend(request) };
