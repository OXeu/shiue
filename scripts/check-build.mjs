import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(path.join(tmpdir(), 'shiue-build-'));
const destination = path.join(output, 'public');
const baseURL = 'https://example.org/';
const result = spawnSync(process.env.HUGO_BIN || 'hugo', [
  '--source', root,
  '--destination', destination,
  '--cacheDir', path.join(output, 'cache'),
  '--baseURL', baseURL,
  '--minify',
  '--printPathWarnings',
  '--noBuildLock',
], {
  encoding: 'utf8',
  env: { ...process.env, HUGO_RESOURCEDIR: path.join(output, 'resources') },
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.ifError(result.error);
assert.equal(result.status, 0, `Hugo 构建失败，产物目录：${output}`);

function read(relative) {
  const file = path.join(destination, relative);
  assert.ok(existsSync(file), `缺少构建产物：${relative}`);
  return readFileSync(file, 'utf8');
}

function localAsset(url) {
  const parsed = new URL(url.replaceAll('&amp;', '&'), baseURL);
  if (parsed.origin !== new URL(baseURL).origin) return;
  const file = path.join(destination, decodeURIComponent(parsed.pathname));
  assert.ok(existsSync(file) && statSync(file).isFile(), `引用的资源不存在：${url}`);
  assert.ok(statSync(file).size > 0, `引用的资源为空：${url}`);
}

const home = read('index.html');
assert.match(home, /<html[^>]*lang=["']?zh-CN/i, '首页缺少中文语言设置');
assert.match(home, /class=["']?article-list/, '首页未渲染文章列表');
assert.match(home, /<article\b/, '首页缺少文章卡片');
read('page/2/index.html');
read('archives/index.html');
read('search/index.html');
read('404.html');
const rss = read('index.xml');
assert.match(rss, /<rss\b/);
assert.match(rss, /<language>zh-CN<\/language>/i);
assert.match(rss, /<item>/);
const search = JSON.parse(read('search/index.json'));
assert.ok(Array.isArray(search) && search.length > 0, '搜索索引为空');
for (const article of search) {
  const url = new URL(article.permalink, baseURL);
  const html = read(path.join(decodeURIComponent(url.pathname), 'index.html'));
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    localAsset(match[1] || match[2] || match[3]);
  }
}
const styles = [...home.matchAll(/<link\b[^>]*href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
  .map(match => match[1] || match[2] || match[3]).filter(url => url.endsWith('.css'));
assert.ok(styles.length > 0, '首页缺少样式文件');
styles.forEach(localAsset);
console.log(`构建验证通过：${search.length} 条搜索记录，首页、分页、归档、RSS、样式与本地图片均存在。产物：${destination}`);
