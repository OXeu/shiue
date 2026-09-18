import { requireSecret } from '../server/comments/core.js';
import { checkRequest, failure, json, readPages, readSubmission } from '../server/comments/http.js';
import { issueProof, powDifficulty } from '../server/comments/pow.js';

export async function challengeComment(request, { env = process.env, pages = readPages, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    requireSecret(env.COMMENTS_POW_SECRET);
    powDifficulty(env);
    const { claim } = await readSubmission(request, site, now, pages);
    return json(200, issueProof(claim.comment, site, env, now));
  } catch (error) { return failure(error); }
}
export default { fetch: request => challengeComment(request) };
