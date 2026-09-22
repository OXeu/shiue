// 选填邮箱的加密存储。
//
// 发布到公开 Git 仓库的评论文件不保存明文邮箱，只保存：
//   emailEncrypted  AES-256-GCM 密文（AAD 绑定评论编号与文章路径）
//   emailHash       带密钥的指纹，用于判定重复审批，不能反查邮箱
//
// GitHub Action 的发布脚本不解密邮箱；只有通知发送方（本服务）
// 能用派生的邮箱密钥还原收件地址。

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { normalizeEmail, requireSecret, UUID, validateComment, validateEmailContact } from './core.js';

const key = secret => createHmac('sha256', requireSecret(secret)).update('comment-email-encryption-v1').digest();
const context = comment => JSON.stringify([comment.id, comment.path]);
const fingerprint = (email, comment, secret) =>
  createHmac('sha256', requireSecret(secret)).update(`comment-email-identity-v1\0${context(comment)}\0${email}`).digest('hex');

/** 加密评论中的选填邮箱；未填写时返回无邮箱的评论。 */
export function sealComment(input, secret) {
  const { email, ...comment } = validateComment(input);
  if (!email) return comment;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
  cipher.setAAD(Buffer.from(context(comment)));
  const encrypted = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return {
    ...comment,
    emailEncrypted: ['v1', nonce.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.'),
    emailHash: fingerprint(email, comment, secret),
  };
}

/** 解密已发布评论的邮箱密文；无密文或校验失败返回 undefined。 */
export function openCommentEmail(input, secret) {
  if (!UUID.test(input.id) || typeof input.path !== 'string') throw new Error('Invalid notification context');
  const comment = { id: input.id, path: input.path, ...validateEmailContact(input) };
  if (!comment.emailEncrypted) return undefined;
  const [, nonce, encrypted, tag] = comment.emailEncrypted.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(nonce, 'base64url'));
  decipher.setAAD(Buffer.from(context(comment)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const email = normalizeEmail(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'));
  // 密文通过认证解密后仍需指纹复核，防篡改。
  if (!email || fingerprint(email, comment, secret) !== comment.emailHash) throw new Error('Invalid notification email');
  return email;
}
