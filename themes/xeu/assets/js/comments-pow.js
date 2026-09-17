export function solveProof(workerURL, task, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    if (task.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(task.challenge) ||
        !Number.isInteger(task.difficulty) || task.difficulty < 4 || task.difficulty > 6 ||
        typeof task.token !== 'string' || task.token.length > 2048 || !Number.isSafeInteger(task.expiresAt)) {
      reject(new Error('验证任务无效，请稍后重试。')); return;
    }
    let worker;
    let timer;
    let finished = false;
    const finish = (error, proof) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker?.terminate();
      error ? reject(error) : resolve(proof);
    };
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    const failed = () => finish(new Error('浏览器验证未能完成，请稍后重试或使用支持 Web Crypto 的浏览器。内容已保留。'));
    try {
      worker = new Worker(workerURL);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(failed, 90000);
      worker.onerror = failed;
      worker.onmessageerror = failed;
      worker.onmessage = ({ data }) => {
        if (finished) return;
        if (data.error) { failed(); return; }
        if (typeof data.nonce === 'string' && /^(0|[1-9]\d{0,15})$/.test(data.nonce)) {
          finish(null, { token: task.token, nonce: data.nonce });
        } else if (Number.isInteger(data.elapsed)) onProgress(data.elapsed);
      };
      worker.postMessage({ challenge: task.challenge, difficulty: task.difficulty });
    } catch { failed(); }
  });
}
