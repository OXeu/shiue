import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameStoredComment, validateStoredComment } from '../../functions/comments/core.js';
import { parseCommentFile } from '../../functions/comments/storage.js';

export function pushComment({ file, branch, cwd = process.cwd() }) {
  parseCommentFile(file);
  if (!/^[\w./-]+$/.test(branch || '') || branch.startsWith('-')) throw new Error('Invalid publish target');
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['check-ref-format', `refs/heads/${branch}`]);
  git(['add', '--', file]);
  const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd });
  if (diff.status === 1) git(['commit', '-m', `comments: publish ${path.basename(file, '.json')}`]);
  else if (diff.status !== 0) throw new Error('Could not inspect staged comment');
  // 不使用全局 Actions concurrency：它只保留一个 pending job，会丢掉突发审批。
  // 每条评论独立文件，非快进时重放到最新分支，绝不 force push。
  for (let attempt = 0; attempt < 5; attempt++) {
    if (spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd, stdio: 'pipe' }).status === 0) return;
    git(['fetch', 'origin', `refs/heads/${branch}`]);
    try { git(['rebase', 'FETCH_HEAD']); }
    catch (error) {
      // 同一审批的随机邮箱密文可能不同；只合并本条留言且公开内容与邮箱摘要完全一致的冲突。
      const conflicts = git(['diff', '--name-only', '--diff-filter=U']).toString().trim().split('\n');
      if (conflicts.length !== 1 || conflicts[0] !== file) throw error;
      const upstream = git(['show', `:2:${file}`]).toString();
      const local = git(['show', `:3:${file}`]).toString();
      if (!sameStoredComment(JSON.parse(upstream), JSON.parse(local))) throw error;
      writeFileSync(path.join(cwd, file), upstream);
      git(['add', '--', file]);
      git(['-c', 'core.editor=true', 'rebase', '--continue']);
    }
  }
  throw new Error('Branch remained busy or write permission was denied');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.env.COMMENT_FILE;
    const { id } = parseCommentFile(file);
    const comment = validateStoredComment(JSON.parse(await readFile(file, 'utf8')));
    if (id !== comment.id) throw new Error();
    pushComment({ file, branch: process.env.COMMENTS_BRANCH });
    console.log('评论提交已推送。');
  } catch { console.error('推送评论失败，请检查分支权限或重新运行任务。'); process.exitCode = 1; }
}
