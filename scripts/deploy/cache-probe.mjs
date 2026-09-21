import { randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJSON } from './files.mjs';

const firstLevelLimit = 200;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const probePattern = /^cloudflare-build-probe-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;

function emptyCounts() {
  return { files: 0, directories: 0, links: 0, bytes: 0, errors: 0 };
}

function add(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatCounts(counts) {
  const details = `${counts.files} 个文件 · ${counts.directories} 个目录 · ${formatBytes(counts.bytes)}`;
  const links = counts.links ? ` · ${counts.links} 个链接` : '';
  const errors = counts.errors ? ` · ${counts.errors} 个读取错误` : '';
  return `${details}${links}${errors}`;
}

export function cacheProbeEnabled(env = process.env) {
  if ('SHIUE_CACHE_PROBE' in env) return env.SHIUE_CACHE_PROBE !== '0';
  return env.WORKERS_CI === '1';
}

/** Cloudflare Workers Builds selects the package manager from the repository, so only npm's
 * global cache is relevant here. Framework candidates are deliberately all probed even though this repository is Hugo:
 * the purpose of this temporary diagnostic is to observe what the platform restores. */
export function cacheProbeTargets(root, env = process.env) {
  const home = env.HOME || os.homedir();
  return [
    ['npm 全局缓存', path.join(home, '.npm')],
    ['Astro 构建缓存', path.join(root, 'node_modules/.astro')],
    ['Docusaurus / 通用 node_modules 缓存', path.join(root, 'node_modules/.cache')],
    ['Docusaurus 状态目录', path.join(root, '.docusaurus')],
    ['Docusaurus 构建目录', path.join(root, 'build')],
    ['Eleventy / Gatsby / Hugo 候选缓存', path.join(root, '.cache')],
    ['Gatsby 构建目录', path.join(root, 'public')],
    ['Next.js 构建缓存', path.join(root, '.next/cache')],
    ['Nuxt 构建缓存', path.join(root, 'node_modules/.cache/nuxt')],
    ['SvelteKit 图片缓存', path.join(root, 'node_modules/.cache/imagetools')],
  ].map(([label, location]) => ({ label, path: location }));
}

async function classify(location) {
  try {
    const info = await lstat(location);
    if (info.isDirectory()) return { type: 'directory', counts: { ...emptyCounts(), directories: 1 } };
    if (info.isFile()) return { type: 'file', counts: { ...emptyCounts(), files: 1, bytes: info.size } };
    if (info.isSymbolicLink()) return { type: 'link', counts: { ...emptyCounts(), links: 1 } };
    return { type: 'other', counts: emptyCounts() };
  } catch (error) {
    if (error.code === 'ENOENT') return { type: 'missing', counts: emptyCounts() };
    return { type: 'error', counts: { ...emptyCounts(), errors: 1 }, error: error.code || error.message };
  }
}

async function scanFirstLevelEntry(location, name) {
  const result = { name, ...(await classify(location)) };
  if (result.type !== 'directory') return result;
  const stack = [location];
  while (stack.length) {
    const directory = stack.pop();
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      result.counts.errors++;
      continue;
    }
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        result.counts.directories++;
        stack.push(childPath);
      } else if (child.isFile()) {
        result.counts.files++;
        try { result.counts.bytes += (await lstat(childPath)).size; }
        catch { result.counts.errors++; }
      } else if (child.isSymbolicLink()) result.counts.links++;
      else {
        const classified = await classify(childPath);
        add(result.counts, classified.counts);
      }
    }
  }
  return result;
}

export async function scanCacheDirectory(target) {
  let entries;
  try {
    entries = await readdir(target.path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { ...target, status: 'missing', counts: emptyCounts(), entries: [] };
    return { ...target, status: 'error', error: error.code || error.message, counts: { ...emptyCounts(), errors: 1 }, entries: [] };
  }
  const firstLevel = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    firstLevel.push(await scanFirstLevelEntry(path.join(target.path, entry.name), entry.name));
  }
  const counts = emptyCounts();
  for (const entry of firstLevel) add(counts, entry.counts);
  return { ...target, status: 'present', counts, entries: firstLevel };
}

export async function captureBuildCaches({ root, env = process.env } = {}) {
  const snapshots = [];
  for (const target of cacheProbeTargets(root, env)) snapshots.push(await scanCacheDirectory(target));
  return { capturedAt: new Date().toISOString(), snapshots };
}

export async function placeBuildCacheProbe({ root, env = process.env, id = randomUUID(), now = new Date() }) {
  if (!uuidPattern.test(id)) throw new Error('构建缓存探针 ID 必须是 UUID');
  const cache = path.join(root, '.cache');
  const existing = await readdir(cache).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of existing) {
    if (probePattern.test(name)) await rm(path.join(cache, name), { force: true });
  }
  const name = `cloudflare-build-probe-${id}.json`;
  const file = path.join(cache, name);
  const probe = {
    schemaVersion: 1,
    id,
    createdAt: now.toISOString(),
    environment: env.WORKERS_CI === '1' ? 'cloudflare-workers-builds' : 'manual',
  };
  await writeJSON(file, probe);
  return { ...probe, file, name };
}

export function formatBuildCacheProbe(probe) {
  return `[构建缓存探针] 已写入 ${probe.file} · UUID ${probe.id}`;
}

function entryMarker(entry) {
  return { directory: '目录', file: '文件', link: '链接', other: '其他', error: '错误' }[entry.type] || entry.type;
}

export function formatBuildCacheSnapshot(snapshot, phase) {
  const lines = [`[构建缓存探测 · ${phase}] ${snapshot.capturedAt}`];
  for (const item of snapshot.snapshots) {
    if (item.status === 'missing') {
      lines.push(`- ${item.label}：不存在 · ${item.path}`);
      continue;
    }
    if (item.status === 'error') {
      lines.push(`- ${item.label}：无法读取（${item.error}）· ${item.path}`);
      continue;
    }
    lines.push(`- ${item.label}：${formatCounts(item.counts)} · ${item.path}`);
    if (!item.entries.length) {
      lines.push('  首层：（空）');
      continue;
    }
    lines.push('  首层：');
    for (const entry of item.entries.slice(0, firstLevelLimit)) {
      lines.push(`    [${entryMarker(entry)}] ${entry.name} · ${formatCounts(entry.counts)}`);
    }
    if (item.entries.length > firstLevelLimit) lines.push(`    … 另有 ${item.entries.length - firstLevelLimit} 项未展开（首层共 ${item.entries.length} 项）`);
  }
  return lines.join('\n');
}

export function formatBuildCacheDelta(before, after) {
  const prior = new Map(before.snapshots.map(item => [item.path, item]));
  const lines = ['[构建缓存探测 · 前后变化]'];
  for (const current of after.snapshots) {
    const previous = prior.get(current.path);
    if (!previous || previous.status !== 'present' || current.status !== 'present') {
      if (previous?.status !== current.status) lines.push(`- ${current.label}：${previous?.status || 'unknown'} → ${current.status}`);
      continue;
    }
    const files = current.counts.files - previous.counts.files;
    const bytes = current.counts.bytes - previous.counts.bytes;
    const directories = current.counts.directories - previous.counts.directories;
    if (!files && !bytes && !directories) lines.push(`- ${current.label}：无变化`);
    else lines.push(`- ${current.label}：文件 ${files >= 0 ? '+' : ''}${files} · 目录 ${directories >= 0 ? '+' : ''}${directories} · 大小 ${bytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`);
  }
  return lines.join('\n');
}
