// 友链申请的 HTTP 适配层。

import { CommentError } from '../comments/core.js';
import { failure } from '../comments/http.js';
import { friendClaim } from './core.js';

/** 友链业务错误：复用评论的错误结构，替换文案中的「评论」字样。 */
export function friendFailure(error) {
  return failure(error instanceof CommentError
    ? new CommentError(error.status, error.message.replaceAll('评论', '友链申请'), error.details)
    : new CommentError(503, '友链申请服务暂时不可用，请稍后重试。'));
}

/** 校验友链提交：公开同意标记与隐藏诱捕字段（contact）。 */
export function validateFriendSubmission(input, site, now) {
  if (input.consent !== true) throw new CommentError(400, '请先确认公开站点信息及 Git 历史记录说明。');
  if (input.contact !== '') throw new CommentError(400, '申请未通过校验。');
  return friendClaim(input, site, now);
}
