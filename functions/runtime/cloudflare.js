import { handleSubmission } from '../submissions.js';

export function handleCloudflareSubmission(request, env, deployment = env.COMMENTS_ENV || 'development') {
  return handleSubmission(request, {
    env,
    deployment,
    pages: async () => {
      // Read this deployment's whitelist through the asset binding, never the public network.
      const response = await env.ASSETS.fetch(new URL('/comment-pages.json', request.url));
      if (!response.ok) { await response.body?.cancel(); throw new Error('Comment pages unavailable'); }
      return response.json();
    },
  });
}
