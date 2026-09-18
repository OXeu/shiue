import { CommentError, commentSecret, digest, readApproval, sign, verify, validateCommentDirectory, validateCommentPage } from '../server/comments/core.js';
import { checkRequest, failure, json, readJSON, readPages } from '../server/comments/http.js';
import { sealComment } from '../server/comments/email.js';
import { sendCommentNotifications } from '../server/comments/notifications.js';

const NOTIFICATION_PURPOSE = 'comment-notifications-v1';
async function notify(claim, receipt, env, fetchImpl) {
  const notifications = await sendCommentNotifications(claim, receipt.parent, env, fetchImpl, receipt.types);
  const retry = notifications.failed.length > 0;
  return json(202, {
    message: retry ? '发布任务已提交，但部分通知邮件未能发送。可重试通知，不会重新发布留言。' : `已提交发布任务，评论将在构建和部署成功后显示。${notifications.sent ? '通知邮件已交由邮件服务发送。' : ''}`,
    actionsURL: `https://github.com/${receipt.repository}/actions/workflows/publish-comment.yml`,
    notifications: { sent: notifications.sent, failed: notifications.failed.length },
    ...(retry ? { notificationToken: sign({ ...receipt, types: notifications.failed }, commentSecret(env, 'approval'), NOTIFICATION_PURPOSE) } : {}),
  });
}

export async function approveComment(request, { env = process.env, fetchImpl = fetch, pages = readPages, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    const input = await readJSON(request);
    const approvalSecret = commentSecret(env, 'approval');
    const claim = readApproval(input.token, approvalSecret, site, now);
    if (input.action === 'preview') return json(200, { comment: claim.comment, title: claim.title, url: claim.url, expiresAt: claim.expiresAt });
    if (input.action === 'notify') {
      const receipt = verify(input.notificationToken, approvalSecret, NOTIFICATION_PURPOSE);
      if (receipt?.v !== 1 || receipt.claimDigest !== digest(claim) || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now || receipt.expiresAt > claim.expiresAt || !Array.isArray(receipt.types) || !receipt.types.length || receipt.types.some(type => !['approval', 'reply'].includes(type))) throw new CommentError(400, '通知重试凭据无效或已过期，请重新打开审批邮件。');
      return await notify(claim, receipt, env, fetchImpl);
    }
    if (input.action !== 'approve') throw new CommentError(400, '未知审批操作。');
    const page = validateCommentPage(claim.comment, (await pages()).find(page => page.path === claim.comment.path));
    const directory = validateCommentDirectory(page.directory);
    const repository = env.COMMENTS_GITHUB_REPOSITORY;
    const branch = env.COMMENTS_GITHUB_BRANCH || 'master';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[\w./-]+$/.test(branch) || !env.COMMENTS_GITHUB_TOKEN) throw new CommentError(503, '评论发布流程尚未配置完成。');
    const workflowSecret = commentSecret(env, 'workflow');
    const comment = sealComment(claim.comment, claim.comment.email ? commentSecret(env, 'email') : undefined);
    const envelope = sign({ v: 1, repository, directory, comment, approvedAt: new Date(now).toISOString(), expiresAt: claim.expiresAt }, workflowSecret, 'comment-publish-v1');
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/publish-comment.yml/dispatches`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.COMMENTS_GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
      body: JSON.stringify({ ref: branch, inputs: { envelope } }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new CommentError(502, '发布任务未被接受，请稍后重新确认。');
    const contact = page.notificationEmails?.[claim.comment.parentId];
    const parent = contact ? { ...contact, id: claim.comment.parentId, path: claim.comment.path } : undefined;
    return await notify(claim, { v: 1, claimDigest: digest(claim), repository, parent, types: ['approval', 'reply'], expiresAt: Math.min(claim.expiresAt, now + 24 * 60 * 60 * 1000) }, env, fetchImpl);
  } catch (error) { return failure(error); }
}
export default { fetch: request => approveComment(request) };
