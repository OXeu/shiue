import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './deploy/process.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 只使用 Node 内置模块：此时依赖可能尚未安装。
export async function installDependencies(root = projectRoot, { log = console.log } = {}) {
  const cache = path.join(root, 'node_modules/.cache/xeu-images');
  const staging = path.join(root, '.cache/deploy');
  await mkdir(staging, { recursive: true });
  const temporary = await mkdtemp(path.join(staging, 'image-cache-install-'));
  const saved = path.join(temporary, 'xeu-images');
  let preserved = false;
  try {
    try {
      await rename(cache, saved);
      preserved = true;
      log('已保留上次构建的缩略图与 BlurHash 缓存。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await command('npm', ['ci'], { cwd: root, log });
  } finally {
    // npm ci 会清空 node_modules；即使安装失败也恢复缓存，便于重试。
    if (preserved) {
      await mkdir(path.dirname(cache), { recursive: true });
      await rename(saved, cache);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installDependencies();
}
