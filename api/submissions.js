import { handleSubmission as submit } from '../functions/submissions.js';
import { readPages } from '../functions/runtime/node.js';

// Vercel 强制从 api/ 目录发现函数；此文件是唯一的桥接入口，
// 全部实现位于 functions/。VERCEL_ENV 区分生产与预览环境。

export function handleSubmission(request, { env = process.env, ...options } = {}) {
  return submit(request, { env, pages: readPages, deployment: env.VERCEL_ENV || 'production', ...options });
}

export default { fetch: request => handleSubmission(request) };
