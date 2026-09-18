export async function post(endpoint, body, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  // Allow sequential Siteverify (10 s) and moderation email (12 s) requests.
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '服务暂时不可用，请稍后重试。');
    return result;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
