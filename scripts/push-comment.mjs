import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateComment } from '../server/comments/core.js';

export function pushComment({ file, branch, cwd = process.cwd() }) {
  if (!/^data\/comments\/[0-9a-f-]{36}\.json$/.test(file || '') || !/^[\w./-]+$/.test(branch || '') || branch.startsWith('-')) throw new Error('Invalid publish target');
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
    git(['rebase', 'FETCH_HEAD']);
  }
  throw new Error('Branch remained busy or write permission was denied');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.env.COMMENT_FILE;
    if (!/^data\/comments\/[0-9a-f-]{36}\.json$/.test(file || '')) throw new Error();
    const comment = validateComment(JSON.parse(await readFile(file, 'utf8')));
    if (file !== `data/comments/${comment.id}.json`) throw new Error();
    pushComment({ file, branch: process.env.COMMENTS_BRANCH });
    console.log('评论提交已推送。');
  } catch { console.error('推送评论失败，请检查分支权限或重新运行任务。'); process.exitCode = 1; }
}
