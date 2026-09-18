import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CommentError, UUID, validateStoredComment, validateCommentDirectory } from './core.js';

export function commentFile(directory, id) {
  validateCommentDirectory(directory);
  if (!UUID.test(id)) throw new CommentError(400, '评论编号无效。');
  return `content/${directory}/comments/${id}.json`;
}

export function parseCommentFile(file) {
  const match = typeof file === 'string' && /^content\/(.+)\/comments\/([^/]+)\.json$/.exec(file);
  if (!match || commentFile(match[1], match[2]) !== file) throw new CommentError(400, '评论文件路径无效。');
  return { directory: match[1], id: match[2] };
}

export async function checkCommentDirectory(root, directory) {
  validateCommentDirectory(directory);
  // 不允许文章或 comments 目录中的符号链接将写入重定向到其他位置。
  let current = root;
  for (const part of ['content', ...directory.split('/'), 'comments']) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => {
      if (error.code === 'ENOENT' && part === 'comments') return null;
      throw error;
    });
    if (info && !info.isDirectory()) throw new CommentError(400, '评论目录必须是文章内的普通目录。');
  }
  if (!(await lstat(path.join(root, 'content', directory, 'index.md'))).isFile()) throw new CommentError(400, '文章不存在。');
}

export async function checkCommentParent(root, directory, comment) {
  const seen = new Set([comment.id]);
  let id = comment.parentId;
  while (id) {
    if (seen.has(id)) throw new CommentError(400, '留言回复关系存在循环。');
    seen.add(id);
    const target = path.join(root, commentFile(directory, id));
    let parent;
    try {
      if (!(await lstat(target)).isFile()) throw new Error();
      parent = validateStoredComment(JSON.parse(await readFile(target, 'utf8')));
    } catch (error) {
      // 已发布回复的祖先可能被删除；直接回复对象仍必须存在。
      if (error.code === 'ENOENT' && id !== comment.parentId) break;
      throw new CommentError(400, '回复的留言不存在或无效。');
    }
    if (parent.id !== id || parent.path !== comment.path) throw new CommentError(400, '回复的留言不属于此文章。');
    id = parent.parentId;
  }
}
