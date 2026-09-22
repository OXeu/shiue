// 评论与友链申请的统一提交入口。
//
// 前端与审核页都只调用 POST /api/submissions，用 JSON 中的
// type（comment | friend）和 action 区分操作：
//
//   challenge  获取 Turnstile 组件配置（不请求 Cloudflare）
//   submit     完成 Turnstile 验证后送审，触发审核邮件
//   preview    从审核邮件打开，仅预览待发布内容
//   approve    确认页批准，发起 GitHub Action 发布
//   notify     仅评论：重试发送失败的通知邮件（不重新发布）
//
// 所有 action 共用同一套验签、限长和同源校验；两条业务线
// 只在字段校验与邮件模板上分叉。

import { randomUUID } from 'node:crypto';
import { CommentError, commentSecret, digest, moderationEmail, readApproval, sign, validateComment, validateCommentDirectory, validateCommentPage } from './comments/core.js';
import { checkRequest, failure, json, readJSON, validateSubmission } from './comments/http.js';
import { TURNSTILE_TTL, turnstileChallenge, verifyTurnstile } from './turnstile.js';
import { sealComment } from './comments/email.js';
import { notifyComment, retryCommentNotifications } from './comments/approval.js';
import { APPROVAL_PURPOSE, friendEmail, PUBLISH_PURPOSE, readFriendApproval, validateFriend } from './friends/core.js';
import { friendFailure, validateFriendSubmission } from './friends/http.js';

const ACTIONS = ['challenge', 'submit', 'preview', 'approve'];
const GITHUB_USER_AGENT = 'OXeu-shiue-comment-publisher';

// 提交编号自带上报时间，允许浏览器在 24 小时内携带同一编号重试，
// 使邮件幂等键保持一致；窗口两端各留 5 分钟容忍时钟偏差。
const SUBMISSION_TTL = 24 * 60 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;

export async function handleSubmission(request, { env = {}, fetchImpl = fetch, pages, deployment = 'development', now = Date.now() } = {}) {
  // 友链与评论复用同一处理器；出错时按业务线替换文案中的「评论」字样。
  let respondToError = failure;
  try {
    const site = checkRequest(request, env, deployment);
    const input = await readJSON(request);
    if (!['comment', 'friend'].includes(input.type)) throw new CommentError(400, '未知提交类型。');
    const friend = input.type === 'friend';
    if (friend) respondToError = friendFailure;
    if (![...ACTIONS, ...(friend ? [] : ['notify'])].includes(input.action)) throw new CommentError(400, '未知提交操作。');

    if (input.action === 'challenge' || input.action === 'submit') {
      return await handleSubmit(input, { friend, site, env, fetchImpl, pages, now });
    }
    return await handleApproval(input, { friend, site, env, fetchImpl, pages, now });
  } catch (error) {
    return respondToError(error);
  }
}

/* ---------- 提交链路：challenge 与 submit ---------- */

async function handleSubmit(input, { friend, site, env, fetchImpl, pages, now }) {
  // 校验并规范化表单字段，产出待验证的内容。
  const validateFields = friend ? validateFriend : validateComment;
  if (input.action === 'challenge') renewStaleSubmission(input, validateFields, now);

  const claim = friend
    ? validateFriendSubmission(input, site, now)
    : await validateSubmission(input, site, now, pages);
  const content = friend ? claim.friend : claim.comment;

  // 选填邮箱依赖派生的邮箱密钥；提前探测，避免验证通过后才发现未配置。
  if (!friend && content.email) commentSecret(env, 'email');

  if (input.action === 'challenge') {
    return json(200, {
      ...turnstileChallenge(content, input.type, env),
      submission: { id: content.id, createdAt: content.createdAt },
    });
  }
  return await sendModerationEmail(input, { friend, claim, content, site, env, fetchImpl, now });
}

// 提交编号临近 24 小时有效期或客户端时钟超前时，换新编号并以服务端
// 当前时间重建提交；未过期重试沿用原编号，保证邮件幂等键不变。
function renewStaleSubmission(input, validateFields, now) {
  const { createdAt } = validateFields(input);
  const stale = Date.parse(createdAt) <= now - SUBMISSION_TTL + TURNSTILE_TTL
    || Date.parse(createdAt) > now + CLOCK_SKEW;
  if (stale) {
    input.id = randomUUID();
    input.createdAt = new Date(now).toISOString();
  }
}

async function sendModerationEmail(input, { friend, claim, content, site, env, fetchImpl, now }) {
  if (!env.RESEND_API_KEY || !env.COMMENTS_EMAIL_FROM || !env.COMMENTS_EMAIL_TO) {
    throw new CommentError(503, '评论服务尚未配置完成。');
  }
  // 必须先通过 Turnstile 验证，再发审核邮件；内容摘要不匹配即拒绝。
  await verifyTurnstile(input.turnstileToken, content, input.type, site, env, fetchImpl, now);

  const token = sign(claim, commentSecret(env, 'approval'), friend ? APPROVAL_PURPOSE : 'comment-approval-v1');
  const email = (friend ? friendEmail : moderationEmail)(claim, token, site, env.COMMENTS_EMAIL_FROM, env.COMMENTS_EMAIL_TO);
  // 幂等键绑定提交内容：同内容重试不会重复发信（Resend 去重窗口 24 小时）。
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': `${input.type}-${digest(email)}`,
    },
    body: JSON.stringify(email),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CommentError(502, friend ? '申请暂未送达，请保留内容并重试。' : '评论暂未送达，请保留内容并重试。');
  }
  if (!(await response.json()).id) throw new Error('missing email receipt');

  // 绝不能向提交者返回签名、审批链接或邮件内容，否则可绕过审核。
  return json(202, {
    id: content.id,
    message: friend
      ? '友链申请已送交审核，通过并完成部署后会显示在友链列表中。'
      : '评论已送交审核，通过并完成部署后会显示在这里。',
  });
}

/* ---------- 审批链路：preview / approve / notify ---------- */

async function handleApproval(input, { friend, site, env, fetchImpl, pages, now }) {
  // 解开邮件链接中的签名凭据，校验期限与站点归属。
  const claim = (friend ? readFriendApproval : readApproval)(input.token, commentSecret(env, 'approval'), site, now);

  if (input.action === 'preview') {
    return json(200, friend
      ? { friend: claim.friend, expiresAt: claim.expiresAt }
      : { comment: claim.comment, title: claim.title, url: claim.url, expiresAt: claim.expiresAt });
  }
  if (input.action === 'notify') {
    return await retryCommentNotifications(input.notificationToken, claim, env, fetchImpl, now);
  }
  return await dispatchPublish(claim, { friend, env, fetchImpl, pages, now });
}

// 确认页批准后，将发布数据签名成 envelope，dispatch 对应的 GitHub Action。
async function dispatchPublish(claim, { friend, env, fetchImpl, pages, now }) {
  const { payload, parent } = friend
    ? { payload: { friend: claim.friend }, parent: undefined }
    : await commentPayload(claim, env, pages);

  const repository = env.COMMENTS_GITHUB_REPOSITORY;
  const branch = env.COMMENTS_GITHUB_BRANCH || 'master';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')
    || !/^[\w./-]+$/.test(branch) || branch.startsWith('-')
    || !env.COMMENTS_GITHUB_TOKEN) {
    throw new CommentError(503, friend ? '友链发布流程尚未配置完成。' : '评论发布流程尚未配置完成。');
  }

  const envelope = sign(
    { v: 1, repository, ...payload, approvedAt: new Date(now).toISOString(), expiresAt: claim.expiresAt },
    commentSecret(env, 'workflow'),
    friend ? PUBLISH_PURPOSE : 'comment-publish-v1',
  );
  const workflow = friend ? 'publish-friend.yml' : 'publish-comment.yml';
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
    headers: {
      authorization: `Bearer ${env.COMMENTS_GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': GITHUB_USER_AGENT,
      'x-github-api-version': '2026-03-10',
    },
    body: JSON.stringify({ ref: branch, inputs: { envelope } }),
  });
  if (!response.ok) throw await githubDispatchFailure(response);
  await response.body?.cancel();

  if (friend) {
    return json(202, {
      message: '已提交发布任务，友链将在图标导入、构建和部署成功后显示。',
      actionsURL: `https://github.com/${repository}/actions/workflows/${workflow}`,
    });
  }
  // 评论发布后发送读者通知；失败可凭 notificationToken 单独重试。
  return await notifyComment(claim, {
    v: 1,
    claimDigest: digest(claim),
    repository,
    parent,
    types: ['approval', 'reply'],
    expiresAt: Math.min(claim.expiresAt, now + 24 * 60 * 60 * 1000),
  }, env, fetchImpl);
}

// 组装评论发布载荷：确认文章白名单、目录格式，加密选填邮箱。
async function commentPayload(claim, env, pages) {
  const page = validateCommentPage(claim.comment, (await pages()).find(page => page.path === claim.comment.path));
  const directory = validateCommentDirectory(page.directory);
  const comment = sealComment(claim.comment, claim.comment.email ? commentSecret(env, 'email') : undefined);
  // 被回复的父留言若留有邮箱，通知凭据一并放进载荷。
  const contact = page.notificationEmails?.[claim.comment.parentId];
  const parent = contact
    ? { ...contact, id: claim.comment.parentId, path: claim.comment.path }
    : undefined;
  return { payload: { directory, comment }, parent };
}

/* ---------- 错误透传 ---------- */

// GitHub 拒绝 dispatch 时保留原始错误信息，便于在确认页排查原因；
// 只透传不超过 8 KiB 的 JSON 对象，鉴权头与非 JSON 响应一律不外泄。
async function githubDispatchFailure(response) {
  let body;
  if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    try {
      const text = await response.text();
      if (text.length <= 8192) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      }
    } catch { /* 非法 JSON：只保留状态码。 */ }
  } else {
    await response.body?.cancel();
  }
  const message = typeof body?.message === 'string' && body.message
    ? body.message
    : `GitHub API 请求失败（HTTP ${response.status}）。`;
  return new CommentError(502, message, { upstream: { service: 'github', httpStatus: response.status, ...(body ? { body } : {}) } });
}
