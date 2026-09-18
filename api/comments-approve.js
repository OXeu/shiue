import { CommentError, readApproval, requireSecret, sign } from '../server/comments/core.js';
import { checkRequest, failure, json, readJSON } from '../server/comments/http.js';

export async function approveComment(request, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    const input = await readJSON(request);
    const claim = readApproval(input.token, env.COMMENTS_APPROVAL_SECRET, site, now);
    if (input.action === 'preview') return json(200, { comment: claim.comment, title: claim.title, url: claim.url, expiresAt: claim.expiresAt });
    if (input.action !== 'approve') throw new CommentError(400, '未知审批操作。');
    const repository = env.COMMENTS_GITHUB_REPOSITORY;
    const branch = env.COMMENTS_GITHUB_BRANCH || 'master';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[\w./-]+$/.test(branch) || !env.COMMENTS_GITHUB_TOKEN) throw new CommentError(503, '评论发布流程尚未配置完成。');
    requireSecret(env.COMMENTS_WORKFLOW_SECRET);
    const envelope = sign({ v: 1, repository, comment: claim.comment, approvedAt: new Date(now).toISOString(), expiresAt: claim.expiresAt }, env.COMMENTS_WORKFLOW_SECRET, 'comment-publish-v1');
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/publish-comment.yml/dispatches`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.COMMENTS_GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
      body: JSON.stringify({ ref: branch, inputs: { envelope } }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new CommentError(502, '发布任务未被接受，请稍后重新确认。');
    return json(202, { message: '已提交发布任务，评论将在构建和部署成功后显示。', actionsURL: `https://github.com/${repository}/actions/workflows/publish-comment.yml` });
  } catch (error) { return failure(error); }
}
export default { fetch: request => approveComment(request) };
