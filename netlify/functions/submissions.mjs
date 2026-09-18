import path from 'node:path';
import { handleSubmission } from '../../server/submissions.js';
import { readPages } from '../../server/runtime/node.js';

export default function submissions(request, context) {
  return handleSubmission(request, {
    env: process.env,
    deployment: context?.deploy?.context || 'development',
    // Netlify includes this file at the function bundle's root, independent of module paths.
    pages: () => readPages(path.resolve('public/comment-pages.json')),
  });
}

export const config = { path: '/api/submissions' };
