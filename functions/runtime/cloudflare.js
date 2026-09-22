// Cloudflare Workers 运行时适配：通过 ASSETS 绑定读取当前部署的
// 白名单，而非公共网络请求。

import { handleSubmission } from '../submissions.js';

export function handleCloudflareSubmission(request, env, deployment = env.COMMENTS_ENV || 'development') {
  return handleSubmission(request, {
    env,
    deployment,
    pages: async () => {
      const response = await env.ASSETS.fetch(new URL('/comment-pages.json', request.url));
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Comment pages unavailable');
      }
      return response.json();
    },
  });
}
