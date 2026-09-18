import { handleCloudflareSubmission } from '../../server/runtime/cloudflare.js';

export function onRequest({ request, env }) {
  return handleCloudflareSubmission(request, env);
}
