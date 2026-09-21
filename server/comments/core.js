import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const APPROVAL_TTL = 7 * 24 * 60 * 60 * 1000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class CommentError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new CommentError(503, '评论服务尚未配置完成。');
  return secret;
}
export function commentSecret(env, purpose) {
  const legacyName = { approval: 'COMMENTS_APPROVAL_SECRET', workflow: 'COMMENTS_WORKFLOW_SECRET', email: 'COMMENTS_EMAIL_SECRET' }[purpose];
  if (typeof legacyName !== 'string') throw new Error('Unknown comment secret purpose');
  // 已配置的旧密钥优先，升级代码不会使旧审批、工作流或邮箱密文失效。
  if (env[legacyName]) return requireSecret(env[legacyName]);
  const master = requireSecret(env.COMMENTS_SECRET);
  return Buffer.from(hkdfSync('sha256', master, 'xeu-comment-secrets-v1', purpose, 32)).toString('hex');
}
export function sign(value, secret, purpose) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', requireSecret(secret)).update(`${purpose}.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}
export function verify(token, secret, purpose) {
  requireSecret(secret);
  if (typeof token !== 'string' || token.length > 24000 || !/^[\w-]+\.[\w-]{43}$/.test(token)) throw new CommentError(400, '审批链接无效或已被修改。');
  const [payload, signature] = token.split('.');
  const actual = Buffer.from(signature, 'base64url');
  const expected = createHmac('sha256', secret).update(`${purpose}.${payload}`).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CommentError(400, '审批链接无效或已被修改。');
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new CommentError(400, '审批链接无效。'); }
}
export function siteURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error();
    return url;
  } catch { throw new CommentError(503, '评论服务尚未配置完成。'); }
}
export function normalizeMessage(value, field, max, multiline = false) {
  if (typeof value !== 'string') throw new CommentError(400, `请填写${field}。`);
  const text = value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
  if (!text || [...text].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || (!multiline && /[\n\t]/.test(text))) throw new CommentError(400, `${field}格式不正确或内容过长。`);
  return text;
}
export function normalizeEmail(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new CommentError(400, '邮箱格式不正确。');
  const email = value.trim();
  if (!email) return undefined;
  const [local, domain, extra] = email.split('@');
  if (extra !== undefined || email.length > 254 || !local || local.length > 64 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !domain || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domain)) throw new CommentError(400, '邮箱格式不正确。');
  return `${local}@${domain.toLowerCase()}`;
}
export function validateComment(value) {
  if (!value || typeof value !== 'object' || !UUID.test(value.id || '')) throw new CommentError(400, '评论编号无效。');
  const path = value.path;
  if (typeof path !== 'string' || path.length > 500 || !path.startsWith('/') || path.startsWith('//') || /[\\?#\s]/.test(path) || !path.endsWith('/') || new URL(path, 'https://example.org').pathname !== path) throw new CommentError(400, '文章地址无效。');
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new CommentError(400, '提交时间无效，请刷新后重试。');
  const parentId = value.parentId;
  if (parentId !== undefined && (typeof parentId !== 'string' || !UUID.test(parentId) || parentId === value.id)) throw new CommentError(400, '回复的留言编号无效。');
  const email = normalizeEmail(value.email);
  return { id: value.id, path, name: normalizeMessage(value.name, '昵称', 40), message: normalizeMessage(value.message, '评论', 2000, true), createdAt, ...(parentId === undefined ? {} : { parentId }), ...(email ? { email } : {}) };
}
export function validateStoredComment(value) {
  if (value?.email !== undefined) throw new CommentError(400, '公开评论文件不能包含明文邮箱。');
  const comment = validateComment(value);
  return { ...comment, ...validateEmailContact(value) };
}
export function validateEmailContact(value) {
  if (value.emailEncrypted === undefined && value.emailHash === undefined) return {};
  if (typeof value.emailEncrypted !== 'string' || !/^v1\.[\w-]{16}\.[\w-]{4,339}\.[\w-]{22}$/.test(value.emailEncrypted) || typeof value.emailHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.emailHash)) throw new CommentError(400, '通知邮箱密文无效。');
  return { emailEncrypted: value.emailEncrypted, emailHash: value.emailHash };
}
export function sameStoredComment(left, right) {
  // 随机加密产生不同密文时，仍以带密钥的邮箱摘要和公开内容判定重复审批。
  const canonical = value => JSON.stringify({ ...validateStoredComment(value), emailEncrypted: undefined });
  return canonical(left) === canonical(right);
}
export function validateCommentDirectory(directory) {
  if (typeof directory !== 'string' || !directory.startsWith('post/') || !directory.split('/').every(part => /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(part))) throw new CommentError(400, '文章目录无效。');
  return directory;
}
export function validateCommentPage(comment, page) {
  if (!page || page.path !== comment.path) throw new CommentError(400, '此页面未开放评论。');
  if (comment.parentId && !page.commentIds?.includes(comment.parentId)) throw new CommentError(400, '回复的留言不存在或不属于此文章，请刷新后重试。');
  return page;
}
export function approvalClaim(input, page, site, now) {
  const comment = validateComment(input);
  if (Date.parse(comment.createdAt) < now - 24 * 60 * 60 * 1000 || Date.parse(comment.createdAt) > now + 5 * 60 * 1000) throw new CommentError(400, '提交时间已失效，请刷新后重试。');
  const url = new URL(comment.path, site);
  if (url.origin !== site.origin || !url.pathname.startsWith(site.pathname)) throw new CommentError(400, '文章地址无效。');
  return { v: 1, comment, title: normalizeMessage(page.title, '文章标题', 300), url: url.href, expiresAt: Date.parse(comment.createdAt) + APPROVAL_TTL };
}
export function readApproval(token, secret, site, now) {
  const claim = verify(token, secret, 'comment-approval-v1');
  const comment = validateComment(claim?.comment);
  if (claim.v !== 1 || claim.expiresAt !== Date.parse(comment.createdAt) + APPROVAL_TTL || claim.expiresAt <= now || Date.parse(comment.createdAt) > now + 5 * 60 * 1000) throw new CommentError(410, '审批链接已过期，请让读者重新提交。');
  if (claim.url !== new URL(comment.path, site).href || !new URL(claim.url).pathname.startsWith(site.pathname)) throw new CommentError(400, '审批链接不属于此站点。');
  return { ...claim, comment, title: normalizeMessage(claim.title, '文章标题', 300) };
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function moderationEmail(claim, token, site, from, to) {
  const review = new URL('comment-review/', site);
  // Fragment 不随 HTTP 请求发送，避免审批凭据进入访问日志和 Referer。
  review.hash = `token=${token}`;
  const c = claim.comment;
  const parentURL = c.parentId ? `${claim.url}#comment-${c.parentId}` : '';
  return {
    from, to: [to], subject: `博客评论待审核 · ${claim.title}`,
    text: `文章：${claim.title}\n${claim.url}\n${parentURL ? `回复留言：${parentURL}\n` : ''}昵称：${c.name}\n提交时间：${c.createdAt}\n编号：${c.id}\n\n${c.message}\n\n查看并批准（7 天内有效）：\n${review.href}\n\n忽略此邮件即不发布。请勿转发审批链接。批准后昵称与评论会进入公开 Git 仓库；发布需要等待构建完成。`,
    html: `<h2>博客评论待审核</h2><p>文章：<a href="${escape(claim.url)}">${escape(claim.title)}</a></p>${parentURL ? `<p>回复留言：<a href="${escape(parentURL)}">查看被回复的留言</a></p>` : ''}<p>昵称：${escape(c.name)}<br>提交时间：${escape(c.createdAt)}<br>编号：${c.id}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${escape(c.message)}</pre><p><a href="${escape(review.href)}">查看并批准评论</a></p><p>链接 7 天内有效。打开链接不会直接发布，需要再次确认。忽略此邮件即不发布，请勿转发审批链接。批准后昵称与评论将进入公开 Git 仓库。</p>`,
  };
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
