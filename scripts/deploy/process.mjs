// 子进程封装：统一的取消、超时与输出转发。
//
// 取消策略：先 SIGTERM 进程组（Linux），2 秒后仍存活则 SIGKILL；
// 捕获模式下 stdout 只进返回值，stderr 始终逐行转发给 log。

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function command(file, args, { cwd, env = process.env, signal, log = () => {}, capture = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // 非 Windows 上派生独立进程组，取消时能杀掉整个子进程树。
    const grouped = process.platform !== 'win32';
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: grouped });
    let stdout = '';
    let killTimer;

    const kill = name => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error.code !== 'ESRCH') log(`无法取消子进程：${error.message}`);
      }
    };
    const abort = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2_000);
      killTimer.unref();
    };

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout.on('data', chunk => { if (capture) stdout += chunk; });
    const readers = [child.stdout, child.stderr].map((stream, index) => {
      const reader = createInterface({ input: stream });
      reader.on('line', line => { if (!capture || index === 1) log(line); });
      return reader;
    });

    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      readers.forEach(reader => reader.close());
      if (signal?.aborted) reject(signal.reason);
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`${file} 执行失败（${exitSignal || `退出码 ${code}`}）`));
      else resolve(stdout.trim());
    });
  });
}
