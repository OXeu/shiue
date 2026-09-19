import { randomUUID } from 'node:crypto';
import { CommentError, commentSecret, digest, moderationEmail, readApproval, sign, validateComment, validateCommentDirectory, validateCommentPage } from './comments/core.js';
import { checkRequest, failure, json, readJSON, validateSubmission } from './comments/http.js';
import { TURNSTILE_TTL, turnstileChallenge, verifyTurnstile } from './turnstile.js';
import { sealComment } from './comments/email.js';
import { notifyComment, retryCommentNotifications } from './comments/approval.js';
import { APPROVAL_PURPOSE, friendEmail, PUBLISH_PURPOSE, readFriendApproval, validateFriend } from './friends/core.js';
import { friendFailure, validateFriendSubmission } from './friends/http.js';

export async function handleSubmission(request, { env = {}, fetchImpl = fetch, pages, deployment = 'development', now = Date.now() } = {}) {
  let respondToError = failure;
  try {
    const site = checkRequest(request, env, deployment);
    const input = await readJSON(request);
    if (!['comment', 'friend'].includes(input.type)) throw new CommentError(400, '未知提交类型。');
    const friend = input.type === 'friend';
    if (friend) respondToError = friendFailure;
    if (!['challenge', 'submit', 'preview', 'approve', ...(friend ? [] : ['notify'])].includes(input.action)) throw new CommentError(400, '未知提交操作。');

    if (input.action === 'challenge' || input.action === 'submit') {
      if (input.action === 'challenge') {
        const content = (friend ? validateFriend : validateComment)(input);
        const createdAt = Date.parse(content.createdAt);
        // Keep recent retries identical. Renew old attempts before binding the
        // challenge, leaving enough time for verification at the 24-hour edge.
        if (createdAt <= now - 24 * 60 * 60 * 1000 + TURNSTILE_TTL || createdAt > now + 5 * 60 * 1000) {
          input.id = randomUUID();
          input.createdAt = new Date(now).toISOString();
        }
      }
      const claim = friend ? validateFriendSubmission(input, site, now) : await validateSubmission(input, site, now, pages);
      const content = friend ? claim.friend : claim.comment;
      if (!friend && content.email) commentSecret(env, 'email');
      if (input.action === 'challenge') return json(200, {
        ...turnstileChallenge(content, input.type, env),
        submission: { id: content.id, createdAt: content.createdAt },
      });

      const approvalSecret = commentSecret(env, 'approval');
      if (!env.RESEND_API_KEY || !env.COMMENTS_EMAIL_FROM || !env.COMMENTS_EMAIL_TO) throw new CommentError(503, '评论服务尚未配置完成。');
      // Verification must succeed before sending moderation mail.
      await verifyTurnstile(input.turnstileToken, content, input.type, site, env, fetchImpl, now);
      const token = sign(claim, approvalSecret, friend ? APPROVAL_PURPOSE : 'comment-approval-v1');
      const email = (friend ? friendEmail : moderationEmail)(claim, token, site, env.COMMENTS_EMAIL_FROM, env.COMMENTS_EMAIL_TO);
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `${input.type}-${digest(email)}` },
        body: JSON.stringify(email),
      });
      if (!response.ok) { await response.body?.cancel(); throw new CommentError(502, friend ? '申请暂未送达，请保留内容并重试。' : '评论暂未送达，请保留内容并重试。'); }
      if (!(await response.json()).id) throw new Error('missing email receipt');
      // 绝不能向提交者返回签名、审批链接或邮件内容，否则可以绕过审核。
      return json(202, { id: content.id, message: friend ? '友链申请已送交审核，通过并完成部署后会显示在友链列表中。' : '评论已送交审核，通过并完成部署后会显示在这里。' });
    }

    const claim = (friend ? readFriendApproval : readApproval)(input.token, commentSecret(env, 'approval'), site, now);
    if (input.action === 'preview') return json(200, friend ? { friend: claim.friend, expiresAt: claim.expiresAt } : { comment: claim.comment, title: claim.title, url: claim.url, expiresAt: claim.expiresAt });
    if (input.action === 'notify') return await retryCommentNotifications(input.notificationToken, claim, env, fetchImpl, now);

    let payload;
    let parent;
    if (friend) payload = { friend: claim.friend };
    else {
      const page = validateCommentPage(claim.comment, (await pages()).find(page => page.path === claim.comment.path));
      const directory = validateCommentDirectory(page.directory);
      const comment = sealComment(claim.comment, claim.comment.email ? commentSecret(env, 'email') : undefined);
      payload = { directory, comment };
      const contact = page.notificationEmails?.[claim.comment.parentId];
      if (contact) parent = { ...contact, id: claim.comment.parentId, path: claim.comment.path };
    }
    const repository = env.COMMENTS_GITHUB_REPOSITORY;
    const branch = env.COMMENTS_GITHUB_BRANCH || 'master';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[\w./-]+$/.test(branch) || branch.startsWith('-') || !env.COMMENTS_GITHUB_TOKEN) throw new CommentError(503, friend ? '友链发布流程尚未配置完成。' : '评论发布流程尚未配置完成。');
    const envelope = sign({ v: 1, repository, ...payload, approvedAt: new Date(now).toISOString(), expiresAt: claim.expiresAt }, commentSecret(env, 'workflow'), friend ? PUBLISH_PURPOSE : 'comment-publish-v1');
    const workflow = friend ? 'publish-friend.yml' : 'publish-comment.yml';
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.COMMENTS_GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
      body: JSON.stringify({ ref: branch, inputs: { envelope } }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new CommentError(502, '发布任务未被接受，请稍后重新确认。');
    if (friend) return json(202, { message: '已提交发布任务，友链将在图标导入、构建和部署成功后显示。', actionsURL: `https://github.com/${repository}/actions/workflows/${workflow}` });
    return await notifyComment(claim, { v: 1, claimDigest: digest(claim), repository, parent, types: ['approval', 'reply'], expiresAt: Math.min(claim.expiresAt, now + 24 * 60 * 60 * 1000) }, env, fetchImpl);
  } catch (error) { return respondToError(error); }
}
