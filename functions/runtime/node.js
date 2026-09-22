// Node 运行时（Vercel / Netlify）读取评论文章白名单。
// 白名单由 Hugo 构建生成于 public/comment-pages.json，随函数打包或从磁盘读取。

import { readFile } from 'node:fs/promises';

export async function readPages(file = new URL('../../public/comment-pages.json', import.meta.url)) {
  return JSON.parse(await readFile(file, 'utf8'));
}
