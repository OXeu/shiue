// 部署构建统一入口（npm run deploy / npm run build）。
//
// 职责：解析 CLI 参数、获取进程级单例锁（防并发构建互踩 .cache），
// 然后把步骤表交给 deploy/pipeline.mjs 执行。步骤本身在 deploy/steps.mjs。

import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './deploy/pipeline.mjs';
import { deploymentSteps } from './deploy/steps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const usage = `Xeu 部署构建

  npm run deploy                    完整流程：拉取头像、检测友链、处理图片并构建
  npm run build                     与 deploy 使用同一入口
  npm run build -- --offline         离线构建，需已有站点图标，不访问 GitHub 或友链
  npm run deploy -- --list           仅列出步骤
  npm run deploy -- --destination /path/to/output

支持继续传入 Hugo 构建参数（如 --baseURL https://example.com/blog/）。
开发服务器使用 npm run dev；脚本生成静态产物，不主动发布线上站点。
耗时报告：.cache/deploy/report.json`;

/** 解析命令行参数；未知参数原样透传给 Hugo。 */
export function parseOptions(args) {
  const options = { offline: false, destination: path.join(root, 'public'), hugoArgs: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--offline') options.offline = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--') continue;
    else if (arg === '--source' || arg.startsWith('--source=') || arg === '-s') {
      throw new Error('统一部署入口固定使用本仓库，请勿覆盖 --source');
    } else if (['server', 'version', 'env', 'help', 'completion'].includes(arg)) {
      throw new Error('此入口只执行构建；开发服务器使用 npm run dev');
    } else if (arg === '--destination' || arg === '-d' || arg.startsWith('--destination=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
      if (!value || value.startsWith('-')) throw new Error('--destination 需要目录参数');
      options.destination = path.resolve(root, value);
    } else options.hugoArgs.push(arg);
  }
  return options;
}

/** 加锁执行部署流水线；SIGINT/SIGTERM 触发协作式取消。 */
export async function deploy(options) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('用户取消部署构建'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  const cache = path.join(root, '.cache/deploy');
  const lockFile = path.join(cache, 'run.lock');
  let lock;
  try {
    await mkdir(cache, { recursive: true });
    try {
      lock = await open(lockFile, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`另一个部署构建正在运行；若上次被强制中断，确认没有运行中的任务后删除 ${lockFile}`);
      }
      throw error;
    }
    return await runPipeline({
      steps: deploymentSteps(),
      context: { root, env: { ...process.env }, ...options },
      signal: controller.signal,
      reportPath: path.join(cache, 'report.json'),
    });
  } catch (error) {
    // 130 是 SIGINT 的惯例退出码。
    if (controller.signal.aborted) process.exitCode = 130;
    throw error;
  } finally {
    if (lock) {
      await lock.close();
      await rm(lockFile, { force: true });
    }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(usage);
    else if (options.list) console.log(deploymentSteps().map((step, index) => `${index + 1}. ${step.title} (${step.id})`).join('\n'));
    else await deploy(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode ||= 1;
  }
}
