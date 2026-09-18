import { CommentError, commentSecret, sign } from '../server/comments/core.js';
import { checkRequest, json, readJSON } from '../server/comments/http.js';
import { PUBLISH_PURPOSE, readFriendApproval } from '../server/friends/core.js';
import { friendFailure } from '../server/friends/http.js';

export async function approveFriend(request, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    const input = await readJSON(request);
    const claim = readFriendApproval(input.token, commentSecret(env, 'approval'), site, now);
    if (input.action === 'preview') return json(200, { friend: claim.friend, expiresAt: claim.expiresAt });
    if (input.action !== 'approve') throw new CommentError(400, '未知审批操作。');
    const repository = env.COMMENTS_GITHUB_REPOSITORY;
    const branch = env.COMMENTS_GITHUB_BRANCH || 'master';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[\w./-]+$/.test(branch) || branch.startsWith('-') || !env.COMMENTS_GITHUB_TOKEN) throw new CommentError(503, '友链发布流程尚未配置完成。');
    const envelope = sign({ v: 1, repository, friend: claim.friend, approvedAt: new Date(now).toISOString(), expiresAt: claim.expiresAt }, commentSecret(env, 'workflow'), PUBLISH_PURPOSE);
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/publish-friend.yml/dispatches`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.COMMENTS_GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
      body: JSON.stringify({ ref: branch, inputs: { envelope } }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new CommentError(502, '发布任务未被接受，请稍后重新确认。');
    return json(202, { message: '已提交发布任务，友链将在图标导入、构建和部署成功后显示。', actionsURL: `https://github.com/${repository}/actions/workflows/publish-friend.yml` });
  } catch (error) { return friendFailure(error); }
}
export default { fetch: request => approveFriend(request) };
