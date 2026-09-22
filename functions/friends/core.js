// 友链申请域：字段校验、审批凭据与审核邮件。
// 与评论共用签名体系和 APPROVAL_TTL，但 action 与用途标识独立。

import { isIP } from 'node:net';
import { APPROVAL_TTL, CommentError, normalizeMessage, UUID, verify } from '../comments/core.js';

export const APPROVAL_PURPOSE = 'friend-approval-v1';
export const PUBLISH_PURPOSE = 'friend-publish-v1';

/**
 * 公开 HTTP(S) 网址校验：拒绝登录凭据、自定义端口、IP 直连、
 * 内网后缀与非法域名。提交和预览阶段不请求这些网址；只有确认
 * 批准后由发布任务导入图标，入口校验不替代人工审核。
 */
export function publicURL(value, field = '站点网址') {
  try {
    if (typeof value !== 'string' || value.length > 2000 || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol)
      || url.username || url.password || url.port
      || isIP(host) || host.includes(':') || !host.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
      throw new Error();
    }
    url.hash = '';
    return url.href;
  } catch {
    throw new CommentError(400, `${field}须为公开的 HTTP(S) 网址，不能包含登录信息或自定义端口。`);
  }
}

/** 校验友链申请表单，产出规范化对象。 */
export function validateFriend(value) {
  if (!value || typeof value !== 'object' || !UUID.test(value.id || '')) throw new CommentError(400, '申请编号无效。');
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'string'
    || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) {
    throw new CommentError(400, '提交时间无效，请刷新后重试。');
  }
  return {
    id: value.id,
    title: normalizeMessage(value.title, '站点名称', 80),
    website: publicURL(value.website),
    description: normalizeMessage(value.description, '站点简介', 200),
    icon: value.icon === '' || value.icon === undefined ? '' : publicURL(value.icon, '图标地址'),
    createdAt,
  };
}

/** 构造待签名的友链审批凭据。 */
export function friendClaim(input, site, now) {
  const friend = validateFriend(input);
  if (Date.parse(friend.createdAt) < now - 24 * 60 * 60 * 1000
    || Date.parse(friend.createdAt) > now + 5 * 60 * 1000) {
    throw new CommentError(400, '提交时间已失效，请刷新后重试。');
  }
  return { v: 1, friend, site: site.href, expiresAt: Date.parse(friend.createdAt) + APPROVAL_TTL };
}

/** 验开友链审批令牌并复核期限与站点归属。 */
export function readFriendApproval(token, secret, site, now) {
  const claim = verify(token, secret, APPROVAL_PURPOSE);
  const friend = validateFriend(claim?.friend);
  if (claim.v !== 1
    || claim.expiresAt !== Date.parse(friend.createdAt) + APPROVAL_TTL
    || claim.expiresAt <= now
    || Date.parse(friend.createdAt) > now + 5 * 60 * 1000) {
    throw new CommentError(410, '审批链接已过期，请让申请者重新提交。');
  }
  if (claim.site !== site.href) throw new CommentError(400, '审批链接不属于此站点。');
  return { ...claim, friend };
}

/* ---------- 邮件模板 ---------- */

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** 审核邮件：审批凭据放在 URL fragment，不随 HTTP 请求发送。 */
export function friendEmail(claim, token, site, from, to) {
  const review = new URL('friend-review/', site);
  review.hash = `token=${token}`;
  const f = claim.friend;
  return {
    from,
    to: [to],
    subject: `友情链接待审核 · ${f.title}`,
    text: `站点：${f.title}\n网址：${f.website}\n简介：${f.description}\n图标：${f.icon || '自动获取站点图标'}\n提交时间：${f.createdAt}\n编号：${f.id}\n\n查看并批准（7 天内有效）：\n${review.href}\n\n打开链接不会直接发布，请核对站点与图标来源后确认。忽略邮件即不发布，请勿转发审批链接。批准后站点信息及图标将进入公开 Git 仓库，构建部署后展示。`,
    html: `<h2>友情链接待审核</h2><p>站点：${escape(f.title)}<br>网址：<a href="${escape(f.website)}">${escape(f.website)}</a><br>简介：${escape(f.description)}<br>图标：${escape(f.icon || '自动获取站点图标')}<br>提交时间：${escape(f.createdAt)}<br>编号：${f.id}</p><p><a href="${escape(review.href)}">查看并批准友链</a></p><p>链接 7 天内有效。打开链接不会直接发布，请核对站点与图标来源后确认。忽略邮件即不发布，请勿转发审批链接。批准后站点信息及图标会写入公开 Git 仓库，构建部署后展示。</p>`,
  };
}
