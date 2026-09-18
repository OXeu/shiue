import { handleCloudflareSubmission } from '../server/runtime/cloudflare.js';
import { json } from '../server/comments/http.js';

function deployment(request, env) {
  if (env.COMMENTS_ENV !== 'production') return env.COMMENTS_ENV || 'development';
  // Version preview URLs can inherit production bindings. Never trust Origin alone.
  try {
    return new URL(request.url).origin === new URL(env.COMMENTS_SITE_URL).origin ? 'production' : 'preview';
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
