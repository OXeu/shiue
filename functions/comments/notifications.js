// 读者通知邮件的构造与发送。
//
// 每种通知（approval / reply）使用固定幂等键绑定评论与收件人，
// Resend 的去重窗口为 24 小时，超时重试不会重复发信。

import { commentSecret, digest } from './core.js';
import { openCommentEmail } from './email.js';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function notificationEmail(claim, type, to, from) {
  const c = claim.comment;
  const title = type === 'approval' ? '你的留言已通过审核' : '你的留言收到了回复';
  const introduction = type === 'approval'
    ? '你的留言已通过审核，正在发布。'
    : `${c.name} 回复了你的留言，回复已通过审核，正在发布。`;
  const url = `${claim.url}#comment-${c.id}`;
  const note = '网页将在构建和部署成功后更新，可能需要稍等片刻。此邮件为自动通知，请勿直接回复。';
  return {
    from,
    to: [to],
    subject: `${title} · ${claim.title}`,
    text: `${introduction}\n文章：${claim.title}\n\n${c.message}\n\n查看留言：${url}\n\n${note}`,
    html: `<h2>${title}</h2><p>${escape(introduction)}</p><p>文章：${escape(claim.title)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${escape(c.message)}</pre><p><a href="${escape(url)}">查看留言</a></p><p>${note}</p>`,
  };
}

/**
 * 发送读者通知。每位收件人单独发送，互不暴露邮箱；
 * 自回复（回复对象与作者邮箱相同）只发审核通过通知。
 * 单个收件人失败不影响其他通知，也不影响已接受的发布任务。
 */
export async function sendCommentNotifications(claim, parent, env, fetchImpl, types = ['approval', 'reply']) {
  const results = await Promise.all(types.map(async type => {
    try {
      const to = type === 'approval'
        ? claim.comment.email
        : parent ? openCommentEmail(parent, commentSecret(env, 'email')) : undefined;
      if (!to || (type === 'reply' && to.toLowerCase() === claim.comment.email?.toLowerCase())) {
        return { type, skipped: true };
      }
      if (!env.RESEND_API_KEY || !env.COMMENTS_EMAIL_FROM) throw new Error('Missing email configuration');
      const email = notificationEmail(claim, type, to, env.COMMENTS_EMAIL_FROM);
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': `comment-notify-${type}-${digest({ id: claim.comment.id, path: claim.comment.path, to })}`,
        },
        body: JSON.stringify(email),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Email not accepted');
      }
      if (!(await response.json()).id) throw new Error('Missing email receipt');
      return { type, sent: true };
    } catch {
      return { type, failed: true };
    }
  }));
  return {
    sent: results.filter(result => result.sent).length,
    failed: results.filter(result => result.failed).map(result => result.type),
  };
}
