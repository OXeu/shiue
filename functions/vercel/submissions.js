import { handleSubmission as submit } from '../submissions.js';
import { readPages } from '../runtime/node.js';

export function handleSubmission(request, { env = process.env, ...options } = {}) {
  return submit(request, { env, pages: readPages, deployment: env.VERCEL_ENV || 'production', ...options });
}

export default { fetch: request => handleSubmission(request) };
