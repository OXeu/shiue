// Cloudflare Workers 入口。
//
// /api/* 全部进入 Worker：/api/submissions 接入共享提交处理器，
// 其余 API 路径返回 404；静态资源由 ASSETS 绑定直接提供。

import { handleCloudflareSubmission } from '../runtime/cloudflare.js';
import { json } from '../comments/http.js';

function deployment(request, env) {
  if (env.COMMENTS_ENV !== 'production') return env.COMMENTS_ENV || 'development';
  // 版本预览地址可能继承生产绑定，不能只看 Origin 判定环境。
  try {
    return new URL(request.url).origin === new URL(env.COMMENTS_SITE_URL).origin
      ? 'production'
      : 'preview';
  } catch {
    return 'development';
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/submissions') return handleCloudflareSubmission(request, env, deployment(request, env));
    if (pathname.startsWith('/api/')) return json(404, { error: '接口不存在。' });
    return env.ASSETS.fetch(request);
  },
};
