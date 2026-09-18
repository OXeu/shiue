import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { normalizeEmail, requireSecret, UUID, validateComment, validateEmailContact } from './core.js';

const key = secret => createHmac('sha256', requireSecret(secret)).update('comment-email-encryption-v1').digest();
const context = comment => JSON.stringify([comment.id, comment.path]);
const fingerprint = (email, comment, secret) => createHmac('sha256', requireSecret(secret)).update(`comment-email-identity-v1\0${context(comment)}\0${email}`).digest('hex');

export function sealComment(input, secret) {
  const { email, ...comment } = validateComment(input);
  if (!email) return comment;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
  cipher.setAAD(Buffer.from(context(comment)));
  const encrypted = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return { ...comment, emailEncrypted: ['v1', nonce.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.'), emailHash: fingerprint(email, comment, secret) };
}

export function openCommentEmail(input, secret) {
  if (!UUID.test(input.id) || typeof input.path !== 'string') throw new Error('Invalid notification context');
  const comment = { id: input.id, path: input.path, ...validateEmailContact(input) };
  if (!comment.emailEncrypted) return undefined;
  const [, nonce, encrypted, tag] = comment.emailEncrypted.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(nonce, 'base64url'));
  decipher.setAAD(Buffer.from(context(comment)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const email = normalizeEmail(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'));
  if (!email || fingerprint(email, comment, secret) !== comment.emailHash) throw new Error('Invalid notification email');
  return email;
}
