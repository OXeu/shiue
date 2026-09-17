import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const APPROVAL_TTL = 7 * 24 * 60 * 60 * 1000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class CommentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new CommentError(503, '评论服务尚未配置完成。');
  return secret;
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
export function validateComment(value) {
  if (!value || typeof value !== 'object' || !UUID.test(value.id || '')) throw new CommentError(400, '评论编号无效。');
  const path = value.path;
  if (typeof path !== 'string' || path.length > 500 || !path.startsWith('/') || path.startsWith('//') || /[\\?#\s]/.test(path) || !path.endsWith('/') || new URL(path, 'https://example.org').pathname !== path) throw new CommentError(400, '文章地址无效。');
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new CommentError(400, '提交时间无效，请刷新后重试。');
  return { id: value.id, path, name: normalizeMessage(value.name, '昵称', 40), message: normalizeMessage(value.message, '评论', 2000, true), createdAt };
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
  return {
    from, to: [to], subject: `博客评论待审核 · ${claim.title}`,
    text: `文章：${claim.title}\n${claim.url}\n昵称：${c.name}\n提交时间：${c.createdAt}\n编号：${c.id}\n\n${c.message}\n\n查看并批准（7 天内有效）：\n${review.href}\n\n忽略此邮件即不发布。请勿转发审批链接。批准后昵称与评论会进入公开 Git 仓库；发布需要等待构建完成。`,
    html: `<h2>博客评论待审核</h2><p>文章：<a href="${escape(claim.url)}">${escape(claim.title)}</a></p><p>昵称：${escape(c.name)}<br>提交时间：${escape(c.createdAt)}<br>编号：${c.id}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${escape(c.message)}</pre><p><a href="${escape(review.href)}">查看并批准评论</a></p><p>链接 7 天内有效。打开链接不会直接发布，需要再次确认。忽略此邮件即不发布，请勿转发审批链接。批准后昵称与评论将进入公开 Git 仓库。</p>`,
  };
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
