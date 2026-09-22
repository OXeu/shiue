import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_TTL, CommentError, commentSecret, sameStoredComment, validateStoredComment, verify } from '../server/comments/core.js';
import { checkCommentDirectory, checkCommentParent, commentFile } from '../server/comments/storage.js';

export async function appendApprovedComment({ root, envelope, secret, repository, now = Date.now() }) {
  const claim = verify(envelope, secret, 'comment-publish-v1');
  const comment = validateStoredComment(claim?.comment);
  const approved = Date.parse(claim.approvedAt);
  if (claim.v !== 1 || !repository || claim.repository !== repository || !Number.isFinite(approved) || approved > now + 5 * 60 * 1000 || approved < Date.parse(comment.createdAt) - 5 * 60 * 1000 || claim.expiresAt !== Date.parse(comment.createdAt) + APPROVAL_TTL || claim.expiresAt <= now) throw new CommentError(400, '审批签名已过期或不属于本仓库。');
  // 文章目录来自服务端白名单并受签名保护，绝不将 URL 当作文件路径。
  const relative = commentFile(claim.directory, comment.id);
  await checkCommentDirectory(root, claim.directory);
  await checkCommentParent(root, claim.directory, comment);
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const text = `${JSON.stringify(comment, null, 2)}\n`;
  let created = true;
  try { await writeFile(target, text, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!sameStoredComment(JSON.parse(await readFile(target, 'utf8')), comment)) throw new CommentError(409, '同一评论编号已存在不同内容，拒绝覆盖。');
    created = false;
  }
  return { relative, id: comment.id, created };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // 从 GitHub 事件文件读取不可信输入，绝不把表达式插入 run: shell。
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = await appendApprovedComment({ root: process.cwd(), envelope: event.inputs?.envelope, secret: commentSecret(process.env, 'workflow'), repository: process.env.GITHUB_REPOSITORY });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `comment_file=${result.relative}\ncomment_id=${result.id}\n`);
    console.log(result.created ? `已添加评论 ${result.id}` : `评论 ${result.id} 已存在，不重复添加。`);
  } catch (error) {
    console.error(error instanceof CommentError ? error.message : '写入评论失败；未输出评论正文或审批凭据。');
    process.exitCode = 1;
  }
}
