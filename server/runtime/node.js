import { readFile } from 'node:fs/promises';

export async function readPages(file = new URL('../../public/comment-pages.json', import.meta.url)) {
  return JSON.parse(await readFile(file, 'utf8'));
}
