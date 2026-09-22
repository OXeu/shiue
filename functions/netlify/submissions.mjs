import path from 'node:path';
import { handleSubmission } from '../submissions.js';
import { readPages } from '../runtime/node.js';

// Netlify 函数入口。目录由 netlify.toml 的 functions.directory 指定。
// Netlify 将 included_files 放到函数包根目录，与模块路径无关，
// 因此用工作目录相对路径读取白名单。

export default function submissions(request, context) {
  return handleSubmission(request, {
    env: process.env,
    deployment: context?.deploy?.context || 'development',
    pages: () => readPages(path.resolve('public/comment-pages.json')),
  });
}

export const config = { path: '/api/submissions' };
