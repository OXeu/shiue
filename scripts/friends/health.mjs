import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJSON } from '../deploy/files.mjs';

function requestURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('友链必须是无凭据的 HTTP(S) 网址');
  return url;
}

function networkStatus(error) {
  const codes = [error, error?.cause, ...(error?.cause?.errors || [])].filter(Boolean).map(item => item.code || item.name);
  if (codes.some(code => ['TimeoutError', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code))) return '连接超时';
  if (codes.includes('CERT_HAS_EXPIRED')) return '证书已过期';
  if (codes.some(code => /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))) return '证书异常';
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) return '域名解析失败';
  if (codes.some(code => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code))) return '无法连接';
  return '连接失败';
}

function httpStatus(status) {
  if (status >= 200 && status < 300) return '';
  if (status === 401 || status === 403) return `访问受限（HTTP ${status}）`;
  if (status === 429) return '请求受限（HTTP 429）';
  if (status === 526) return '证书异常（HTTP 526）';
  return `HTTP ${status}`;
}

// Only GET response headers are needed. Some sites reject HEAD even though
// visitors can open them; cancel the body immediately to avoid full downloads.
export async function probeFriend(website, { signal, timeoutMs = 8_000, retries = 1, retryDelayMs = 350, fetchImpl = fetch } = {}) {
  requestURL(website);
  const started = performance.now();
  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let current = website;
    let receivedResponse = false;
    try {
      for (let redirects = 0; ; redirects++) {
        requestURL(current);
        const response = await fetchImpl(current, {
          method: 'GET', redirect: 'manual', signal: requestSignal,
          headers: { 'user-agent': 'Xeu-Link-Health/1.0', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        });
        receivedResponse = true;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          if (redirects >= 5) {
            result = { health: '重定向过多', statusCode: response.status, receivedResponse, finalURL: current };
            break;
          }
          current = requestURL(new URL(location, current).href).href;
          continue;
        }
        result = { health: httpStatus(response.status), statusCode: response.status, receivedResponse, finalURL: current };
        break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      result = { health: timeout.aborted ? '连接超时' : networkStatus(error), statusCode: null, receivedResponse, finalURL: current };
    }
    result.attempts = attempt + 1;
    if (!result.health || (result.statusCode !== null && result.statusCode < 500 && result.statusCode !== 429)) break;
    if (attempt < retries) await delay(retryDelayMs, undefined, { signal });
  }
  return { ...result, durationMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString() };
}

export async function updateFriendHealth({ root, signal, concurrency = 3, log = console.log, warn = console.warn, ...probeOptions }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('友链检测并发必须在 1–10 之间');
  const friends = JSON.parse(await readFile(path.join(root, 'data/friends.json'), 'utf8'));
  if (!Array.isArray(friends)) throw new Error('data/friends.json 必须是数组');
  const seen = new Set();
  for (const friend of friends) {
    requestURL(friend.website);
    if (seen.has(friend.website)) throw new Error(`重复友链：${friend.website}`);
    seen.add(friend.website);
  }
  const results = new Array(friends.length);
  let next = 0;
  let completed = 0;
  log(`${friends.length} 个站点 · 并发 ${concurrency} · 每次请求最多 ${(probeOptions.timeoutMs || 8_000) / 1000}s · 失败重试一次`);
  await Promise.all(Array.from({ length: Math.min(concurrency, friends.length) }, async () => {
    while (next < friends.length) {
      signal?.throwIfAborted();
      const index = next++;
      const friend = friends[index];
      const result = await probeFriend(friend.website, { ...probeOptions, signal });
      results[index] = result;
      log(`${++completed}/${friends.length} ${friend.title} · ${result.health || '正常'} · ${result.durationMs}ms${result.attempts > 1 ? ` · ${result.attempts} 次尝试` : ''}`);
    }
  }));
  signal?.throwIfAborted();
  const unhealthy = results.filter(result => result.health).length;
  // A broken build runner network must not move the entire directory to Away.
  if (friends.length > 1 && results.every(result => !result.receivedResponse)) {
    warn('所有站点均未收到 HTTP 响应，疑似检测环境网络异常；保留上次检测结果（无缓存时使用仓库初始状态）。');
    return { total: friends.length, unhealthy, preserved: true };
  }
  const report = {
    checkedAt: new Date().toISOString(),
    sites: Object.fromEntries(friends.map((friend, index) => [friend.website, results[index]])),
  };
  await writeJSON(path.join(root, 'data/xeu/friend-health.json'), report);
  if (unhealthy) warn(`${unhealthy} 个站点异常或限制访问；已更新状态，部署继续。`);
  return { total: friends.length, healthy: friends.length - unhealthy, unhealthy, preserved: false };
}
