import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateStoredComment } from '../server/comments/core.js';
import { checkCommentDirectory } from '../server/comments/storage.js';

export const SOURCE = 'https://legacy.xeu.life';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalized = value => value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
export const contentHash = value => createHash('sha256').update(value).digest('hex');
const sourceKey = (feedId, commentId) => `${feedId}:${commentId}`;

// The plan only contains public display fields. Never persist guestEmail,
// guestWebsite, profile data, tokens, or the unfiltered API response.
export function selectComments(feedId, records, exclusions = []) {
  if (!Number.isSafeInteger(feedId) || !Array.isArray(records)) throw new Error('旧站评论响应格式无效');
  const decisions = new Map(exclusions.map(item => [sourceKey(item.feedId, item.commentId), item]));
  const identities = new Set();
  const seen = new Map();
  const accepted = [], duplicates = [], filtered = [];
  const comments = records.map(record => {
    if (!Number.isSafeInteger(record.id) || record.id <= 0 || typeof record.content !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error(`旧站文章 ${feedId} 含无效评论`);
    if (identities.has(record.id)) throw new Error(`旧站文章 ${feedId} 返回重复编号 ${record.id}`);
    identities.add(record.id);
    if (record.parentId || record.parent_id || record.replyTo || record.children?.length || record.replies?.length) throw new Error('旧站出现回复层级字段，需要重新确认映射');
    return record;
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  for (const record of comments) {
    const key = sourceKey(feedId, record.id);
    if (record.approved !== 1 && record.approved !== true) {
      filtered.push({ feedId, commentId: record.id, reason: '未审核通过' });
      continue;
    }
    const name = record.user?.username || record.guestName || '匿名';
    if (typeof name !== 'string') throw new Error(`评论 ${key} 的昵称无效`);
    const author = record.user?.id != null ? `user:${record.user.id}` : `guest:${normalized(name)}`;
    const fingerprint = JSON.stringify([author, normalized(record.content)]);
    if (seen.has(fingerprint)) {
      duplicates.push({ feedId, commentId: record.id, duplicateOf: seen.get(fingerprint) });
      continue;
    }
    seen.set(fingerprint, record.id);
    const decision = decisions.get(key);
    if (decision) {
      if (decision.contentSha256 !== contentHash(record.content)) throw new Error(`已人工复核的评论 ${key} 内容发生变化，需要重新复核`);
      filtered.push({ feedId, commentId: record.id, reason: decision.reason, contentSha256: decision.contentSha256 });
      continue;
    }
    accepted.push({ name, message: record.content, createdAt: new Date(record.createdAt).toISOString(), legacy: { source: SOURCE, feedId, commentId: record.id } });
  }
  return { accepted, duplicates, filtered };
}

async function articleMappings(repository) {
  const articles = new Map();
  for (const directory of await readdir(path.join(repository, 'content/post'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const content = await readFile(path.join(repository, 'content/post', directory.name, 'index.md'), 'utf8');
    const metadata = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
    const slug = metadata.match(/^slug:\s*([a-z0-9-]+)\s*$/m)?.[1];
    for (const alias of metadata.matchAll(/^\s*-\s*["']?\/feed\/(\d+)\/?["']?\s*$/gm)) {
      const id = Number(alias[1]);
      if (!slug || articles.has(id)) throw new Error(`文章别名 /feed/${id}/ 存在冲突或缺少 slug`);
      const title = metadata.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
      articles.set(id, { directory: `post/${directory.name}`, path: `/p/${slug}/`, title });
    }
  }
  return articles;
}

export async function buildImportPlan({ repository = root, feeds, commentsByFeed, exclusions = [], idFactory = randomUUID }) {
  const mappings = await articleMappings(repository);
  const files = [], articles = [], duplicates = [], filtered = [];
  let sourceCount = 0, kept = 0, existing = 0;
  const feedIds = new Set();
  for (const feed of feeds) {
    if (feedIds.has(feed.id)) throw new Error(`文章编号重复：${feed.id}`);
    feedIds.add(feed.id);
    const article = mappings.get(feed.id);
    if (!article || normalized(article.title) !== normalized(feed.title)) throw new Error(`旧站文章 ${feed.id}（${feed.title}）无法准确匹配`);
    await checkCommentDirectory(repository, article.directory);
    const directory = path.join(repository, 'content', article.directory, 'comments');
    const previous = new Map();
    const entries = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.filter(entry => entry.endsWith('.json'))) {
      const comment = JSON.parse(await readFile(path.join(directory, entry), 'utf8'));
      if (comment.legacy?.source !== SOURCE) continue;
      validateStoredComment(comment);
      const key = sourceKey(comment.legacy.feedId, comment.legacy.commentId);
      if (previous.has(key) || entry !== `${comment.id}.json` || comment.path !== article.path) throw new Error(`已有迁移评论 ${key} 的编号或文章不一致`);
      previous.set(key, comment);
    }
    const selected = selectComments(feed.id, commentsByFeed[feed.id], exclusions);
    sourceCount += commentsByFeed[feed.id].length;
    kept += selected.accepted.length;
    duplicates.push(...selected.duplicates);
    filtered.push(...selected.filtered);
    for (const draft of selected.accepted) {
      const key = sourceKey(feed.id, draft.legacy.commentId);
      const old = previous.get(key);
      const comment = { id: old?.id || idFactory(), path: article.path, ...draft };
      validateStoredComment(comment);
      if (old) {
        for (const field of ['path', 'name', 'message', 'createdAt']) if (old[field] !== comment[field]) throw new Error(`已有评论 ${key} 与源数据不一致，拒绝覆盖`);
        existing++;
      } else {
        const file = `content/${article.directory}/comments/${comment.id}.json`;
        if (entries.includes(`${comment.id}.json`) || files.some(item => item.path === file)) throw new Error(`评论编号冲突：${comment.id}`);
        files.push({ path: file, content: `${JSON.stringify(comment, null, 2)}\n` });
      }
    }
    articles.push({ feedId: feed.id, title: feed.title, path: article.path, sourceCount: commentsByFeed[feed.id].length, imported: selected.accepted.length, duplicates: selected.duplicates.length, filtered: selected.filtered.length });
  }
  return { source: SOURCE, sourceCount, kept, existing, added: files.length, articles, duplicates, filtered, files };
}

function readPublicJSON(endpoint, address) {
  return new Promise((resolve, reject) => {
    const request = get(new URL(endpoint, SOURCE), {
      headers: { accept: 'application/json', 'user-agent': 'Xeu-Legacy-Comment-Migration/1.0' },
      ...(address ? { lookup: (_hostname, options, callback) => callback(null, options.all ? [{ address, family: isIP(address) }] : address, isIP(address)) } : {}),
    }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('application/json')) {
        response.resume(); reject(new Error(`旧站接口 ${endpoint} 返回 ${response.statusCode}，请检查 DNS / 站点绑定`)); return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) request.destroy(new Error('旧站响应过大'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error(`旧站接口 ${endpoint} 未返回有效 JSON`)); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error('旧站接口请求超时')), 30_000);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
  });
}

async function main() {
  const { values } = parseArgs({ options: { address: { type: 'string' } } });
  if (values.address && !isIP(values.address)) throw new Error('--address 必须是经核实的旧站公网 IP');
  const feeds = [];
  let total;
  for (let page = 1; page <= 100; page++) {
    const result = await readPublicJSON(`/api/feed?limit=100&page=${page}`, values.address);
    if (!Array.isArray(result.data) || typeof result.hasNext !== 'boolean' || !Number.isSafeInteger(result.size)) throw new Error('旧站文章列表格式无效');
    if (total !== undefined && total !== result.size) throw new Error('旧站文章列表在读取期间发生变化，请重新运行');
    total = result.size;
    feeds.push(...result.data.map(({ id, title }) => ({ id, title })));
    if (!result.hasNext) break;
    if (!result.data.length || page === 100) throw new Error('旧站文章列表分页异常');
  }
  if (feeds.length !== total) throw new Error('旧站文章数量不完整');
  const commentsByFeed = {};
  for (let index = 0; index < feeds.length; index += 3) {
    await Promise.all(feeds.slice(index, index + 3).map(async feed => {
      commentsByFeed[feed.id] = await readPublicJSON(`/api/comment/${feed.id}`, values.address);
    }));
  }
  const exclusions = JSON.parse(await readFile(new URL('./legacy-comment-exclusions.json', import.meta.url), 'utf8'));
  const plan = await buildImportPlan({ feeds, commentsByFeed, exclusions });
  process.stdout.write(`${JSON.stringify({ fetchedAt: new Date().toISOString(), ...plan }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
