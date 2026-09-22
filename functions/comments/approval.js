import { CommentError, commentSecret, digest, sign, verify } from './core.js';
import { json } from './http.js';
import { sendCommentNotifications } from './notifications.js';

const NOTIFICATION_PURPOSE = 'comment-notifications-v1';

export async function notifyComment(claim, receipt, env, fetchImpl) {
  const notifications = await sendCommentNotifications(claim, receipt.parent, env, fetchImpl, receipt.types);
  const retry = notifications.failed.length > 0;
  return json(202, {
    message: retry ? '发布任务已提交，但部分通知邮件未能发送。可重试通知，不会重新发布留言。' : `已提交发布任务，评论将在构建和部署成功后显示。${notifications.sent ? '通知邮件已交由邮件服务发送。' : ''}`,
    actionsURL: `https://github.com/${receipt.repository}/actions/workflows/publish-comment.yml`,
    notifications: { sent: notifications.sent, failed: notifications.failed.length },
    ...(retry ? { notificationToken: sign({ ...receipt, types: notifications.failed }, commentSecret(env, 'approval'), NOTIFICATION_PURPOSE) } : {}),
  });
}

export async function retryCommentNotifications(token, claim, env, fetchImpl, now) {
  const receipt = verify(token, commentSecret(env, 'approval'), NOTIFICATION_PURPOSE);
  if (receipt?.v !== 1 || receipt.claimDigest !== digest(claim) || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now || receipt.expiresAt > claim.expiresAt || !Array.isArray(receipt.types) || !receipt.types.length || receipt.types.some(type => !['approval', 'reply'].includes(type))) throw new CommentError(400, '通知重试凭据无效或已过期，请重新打开审批邮件。');
  return notifyComment(claim, receipt, env, fetchImpl);
}
