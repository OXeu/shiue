import { handleSubmission } from '../../server/submissions.js';

export function onRequest({ request, env }) {
  return handleSubmission(request, {
    env,
    deployment: env.COMMENTS_ENV || 'development',
    pages: async () => {
      // Read this deployment's whitelist through the asset binding, never the public network.
      const response = await env.ASSETS.fetch(new URL('/comment-pages.json', request.url));
      if (!response.ok) { await response.body?.cancel(); throw new Error('Comment pages unavailable'); }
      return response.json();
    },
  });
}
