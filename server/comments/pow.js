import { createHash, randomBytes } from 'node:crypto';
import { CommentError, digest, requireSecret, sign, verify } from './core.js';

// Anubis-compatible puzzle: SHA-256(UTF-8(challenge + decimal nonce)),
// difficulty counts zero HEX DIGITS (4 bits each), not zero bytes.
// Independently implemented with Node/Web Crypto; see docs/comments.md.
export const POW_TTL = 5 * 60 * 1000;
const PURPOSE = 'comment-pow-v1';
export function powDifficulty(env) {
  const value = env.COMMENTS_POW_DIFFICULTY ?? '5';
  if (!/^[4-6]$/.test(value)) throw new CommentError(503, '评论工作量证明尚未配置完成。');
  return Number(value);
}
export function issueProof(comment, site, env, now) {
  const claim = {
    v: 1, algorithm: 'sha256', difficulty: powDifficulty(env),
    challenge: randomBytes(32).toString('hex'), binding: digest(comment), site: site.href,
    issuedAt: now, expiresAt: now + POW_TTL,
  };
  return {
    algorithm: claim.algorithm, challenge: claim.challenge, difficulty: claim.difficulty,
    expiresAt: claim.expiresAt, token: sign(claim, env.COMMENTS_POW_SECRET, PURPOSE),
  };
}
export function verifyProof(proof, comment, site, env, now) {
  requireSecret(env.COMMENTS_POW_SECRET);
  const difficulty = powDifficulty(env);
  const invalid = () => new CommentError(403, '工作量证明无效，请重新提交以获取验证任务。');
  if (!proof || typeof proof.token !== 'string' || proof.token.length > 2048 ||
      typeof proof.nonce !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(proof.nonce) || !Number.isSafeInteger(Number(proof.nonce))) throw invalid();
  let claim;
  try { claim = verify(proof.token, env.COMMENTS_POW_SECRET, PURPOSE); }
  catch { throw invalid(); }
  if (!claim || claim.v !== 1 || claim.algorithm !== 'sha256' || claim.difficulty !== difficulty ||
      typeof claim.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(claim.challenge) ||
      claim.binding !== digest(comment) || claim.site !== site.href ||
      !Number.isSafeInteger(claim.issuedAt) || claim.issuedAt > now + 30000 ||
      claim.expiresAt !== claim.issuedAt + POW_TTL) throw invalid();
  if (claim.expiresAt <= now) throw new CommentError(410, '工作量证明已过期，请重新提交。');
  // Only one hash to verify. Never trust a client-supplied hash or difficulty.
  const hash = createHash('sha256').update(claim.challenge).update(proof.nonce).digest('hex');
  if (!hash.startsWith('0'.repeat(difficulty))) throw invalid();
}
