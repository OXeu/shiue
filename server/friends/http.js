import { CommentError } from '../comments/core.js';
import { failure } from '../comments/http.js';
import { friendClaim } from './core.js';

export function friendFailure(error) {
  return failure(error instanceof CommentError ? new CommentError(error.status, error.message.replaceAll('评论', '友链申请')) : new CommentError(503, '友链申请服务暂时不可用，请稍后重试。'));
}

export function validateFriendSubmission(input, site, now) {
  if (input.consent !== true) throw new CommentError(400, '请先确认公开站点信息及 Git 历史记录说明。');
  if (input.contact !== '') throw new CommentError(400, '申请未通过校验。');
  return friendClaim(input, site, now);
}
