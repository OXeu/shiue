import { commentSecret } from '../server/comments/core.js';
import { checkRequest, json } from '../server/comments/http.js';
import { issueProof, powDifficulty } from '../server/comments/pow.js';
import { POW_PURPOSE } from '../server/friends/core.js';
import { friendFailure, readFriendSubmission } from '../server/friends/http.js';

export async function challengeFriend(request, { env = process.env, now = Date.now() } = {}) {
  try {
    const site = checkRequest(request, env);
    commentSecret(env, 'pow');
    powDifficulty(env);
    const { claim } = await readFriendSubmission(request, site, now);
    return json(200, issueProof(claim.friend, site, env, now, POW_PURPOSE));
  } catch (error) { return friendFailure(error); }
}
export default { fetch: request => challengeFriend(request) };
