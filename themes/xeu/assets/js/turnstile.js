let loading;

function loadTurnstile() {
  if (loading) return loading;
  if (typeof globalThis.turnstile?.render === 'function') return Promise.resolve(globalThis.turnstile);
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve(globalThis.turnstile);
    };
    const failed = () => finish(new Error('浏览器验证未能加载，请检查网络后重试。内容已保留。'));
    const timer = setTimeout(failed, 15000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      // The SDK rejects ready() for async scripts, even inside their load event.
      if (typeof globalThis.turnstile?.render !== 'function') return failed();
      finish();
    };
    script.onerror = failed;
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

export function solveTurnstile(container, task, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    if (!container || task?.provider !== 'turnstile' || typeof task.sitekey !== 'string' || !/^[\w-]{1,100}$/.test(task.sitekey) ||
        !['comment', 'friend'].includes(task.action) || !/^[a-f0-9]{64}$/.test(task.cData)) {
      reject(new Error('浏览器验证配置无效，请稍后重试。')); return;
    }
    let api;
    let widget;
    let finished = false;
    const remove = () => { if (widget !== undefined) { try { api.remove(widget); } catch { /* Already removed by the SDK. */ } } };
    const finish = (error, token) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      remove();
      container.replaceChildren();
      container.hidden = true;
      error ? reject(error) : resolve(token);
    };
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    const failed = () => { finish(new Error('浏览器验证未能完成，请重试。内容已保留。')); return true; };
    const expired = () => finish(new Error('浏览器验证已过期，请重试。内容已保留。'));
    const timer = setTimeout(() => finish(new Error('浏览器验证超时，请重试。内容已保留。')), 90000);
    signal.addEventListener('abort', abort, { once: true });
    container.hidden = false;
    loadTurnstile().then(loaded => {
      if (finished) return;
      api = loaded;
      widget = api.render(container, {
        sitekey: task.sitekey, action: task.action, cData: task.cData,
        size: container.clientWidth >= 300 ? 'flexible' : 'compact',
        appearance: 'interaction-only', 'response-field': false,
        retry: 'never', 'refresh-expired': 'never', 'refresh-timeout': 'never',
        callback: token => typeof token === 'string' && token.length > 0 && token.length <= 2048 ? finish(null, token) : failed(),
        'error-callback': failed, 'expired-callback': expired, 'timeout-callback': expired,
        'unsupported-callback': () => finish(new Error('此浏览器不支持验证，请更新浏览器后重试。内容已保留。')),
      });
      if (finished) remove();
    }).catch(error => finish(error));
  });
}
