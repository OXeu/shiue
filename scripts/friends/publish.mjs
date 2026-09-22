// 友链发布（GitHub Action publish-friend.yml 调用）。
//
// 流程：验开审批信封 → 在远程分支的最新快照（临时 worktree）上导入
// 友链与图标 → 提交并推送。数组无法安全地文本 rebase，所以每次重试都
// 基于全新的远程快照，天然保留并发的好友申请与普通提交。

import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_TTL, CommentError, commentSecret, verify } from '../../functions/comments/core.js';
import { PUBLISH_PURPOSE, validateFriend } from '../../functions/friends/core.js';
import { addFriend, websiteKey } from './add.mjs';

/** 验开发布信封并复核：仓库归属、审批时限、7 天有效期。 */
export function readFriendEnvelope({ envelope, secret, repository, now = Date.now() }) {
  const claim = verify(envelope, secret, PUBLISH_PURPOSE);
  const friend = validateFriend(claim?.friend);
  const approved = Date.parse(claim.approvedAt);
  if (claim.v !== 1
    || !repository || claim.repository !== repository
    || !Number.isFinite(approved)
    || approved > now + 5 * 60 * 1000
    || approved < Date.parse(friend.createdAt) - 5 * 60 * 1000
    || claim.expiresAt !== Date.parse(friend.createdAt) + APPROVAL_TTL
    || claim.expiresAt <= now) {
    throw new CommentError(400, '审批签名已过期或不属于本仓库。');
  }
  return friend;
}

/** 在已检出的目录中导入友链；网址已存在则不重复添加。 */
export async function importApprovedFriend(friend, { root, importer = addFriend }) {
  // 目录结构完整性检查：导入器只允许写 data/ 与 static/friends/。
  for (const relative of ['data', 'data/friends.json', 'static', 'static/friends']) {
    const info = await lstat(path.join(root, relative)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (relative.endsWith('.json') ? !info.isFile() : !info.isDirectory())) {
      throw new Error('Invalid friend storage');
    }
  }
  const entries = JSON.parse(await readFile(path.join(root, 'data/friends.json'), 'utf8'));
  if (!Array.isArray(entries)) throw new Error('Invalid friend data');
  if (entries.some(entry => websiteKey(entry.website) === websiteKey(friend.website))) return { created: false };

  const entry = await importer({
    title: friend.title,
    description: friend.description,
    website: friend.website,
    ...(friend.icon ? { icon: friend.icon } : {}),
  }, { root, warn: () => {} });
  if (!/^\/friends\/[a-z0-9.-]+\.(webp|ico)$/i.test(entry.image)) throw new Error('Invalid imported icon');
  return { created: true, image: `static${entry.image}` };
}

/** 在最新远程快照上导入友链并推送；推送冲突（非快进）最多重试 5 次。 */
export async function publishFriend({ root = process.cwd(), branch, importer = addFriend, ...approval }) {
  const friend = readFriendEnvelope(approval);
  if (!/^[\w./-]+$/.test(branch || '') || branch.startsWith('-')) throw new Error('Invalid publish branch');
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['check-ref-format', `refs/heads/${branch}`]);

  for (let attempt = 0; attempt < 5; attempt++) {
    git(['fetch', 'origin', `refs/heads/${branch}`]);
    // 每次尝试都在独立临时目录中的 detached worktree 上进行，
    // 不污染主检出，失败也不留状态。
    const temporary = await mkdtemp(path.join(tmpdir(), 'xeu-friend-publish-'));
    const checkout = path.join(temporary, 'checkout');
    let attached = false;
    try {
      git(['worktree', 'add', '--detach', checkout, 'FETCH_HEAD']);
      attached = true;
      const result = await importApprovedFriend(friend, { root: checkout, importer });
      if (!result.created) return result;
      git(['add', '--', 'data/friends.json', result.image], checkout);
      git(['commit', '-m', `friends: publish ${friend.id}`], checkout);
      if (spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: checkout, stdio: 'pipe' }).status === 0) return result;
    } finally {
      // 只移除本次尝试创建的临时 worktree。
      if (attached) git(['worktree', 'remove', '--force', checkout]);
      await rm(temporary, { recursive: true, force: true });
    }
  }
  throw new Error('Branch remained busy or write permission was denied');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // 从 GitHub 事件文件读取不可信输入，绝不把表达式插入 run: shell。
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = await publishFriend({
      envelope: event.inputs?.envelope,
      secret: commentSecret(process.env, 'workflow'),
      repository: process.env.GITHUB_REPOSITORY,
      branch: process.env.COMMENTS_BRANCH,
    });
    console.log(result.created ? '友链与本地图标已推送。' : '该网址已存在，保留原有友链，不重复添加。');
  } catch (error) {
    console.error(error instanceof CommentError
      ? error.message
      : '发布友链失败，请检查站点图标、分支权限后重新运行任务；未输出审批凭据。');
    process.exitCode = 1;
  }
}
