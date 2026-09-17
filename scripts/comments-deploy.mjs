import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function deployHook(value) {
  const url = new URL(value);
  if (url.origin !== 'https://api.vercel.com' || !/^\/v1\/integrations\/deploy\/[^/]+\/[^/]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('Invalid deploy hook');
  return url.href;
}
export async function deployComments({ hook, fetchImpl = fetch }) {
  const response = await fetchImpl(deployHook(hook), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Deploy hook rejected request');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const hook = deployHook(process.env.VERCEL_DEPLOY_HOOK_URL);
    if (process.argv.includes('--validate')) console.log('部署 Hook 格式检查通过。');
    else { await deployComments({ hook }); console.log('Vercel 部署已排队；最终结果请查看 Vercel。'); }
  } catch { console.error('Vercel 部署未被接受，请检查 Hook 配置并重新运行任务。'); process.exitCode = 1; }
}
