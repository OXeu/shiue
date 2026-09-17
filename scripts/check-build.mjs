import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(path.join(tmpdir(), 'shiue-build-'));
const destination = path.join(output, 'public');
const baseURL = process.env.SHIUE_TEST_BASE_URL || 'https://example.org/';
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

function outputPath(url) {
  const pathname = decodeURIComponent(new URL(url, baseURL).pathname);
  const basePath = decodeURIComponent(new URL(baseURL).pathname);
  assert.ok(pathname.startsWith(basePath), `链接丢失部署子路径：${url}`);
  return path.join(destination, pathname.slice(basePath.length));
}

function localAsset(url, parent = baseURL) {
  const parsed = new URL(url.replaceAll('&amp;', '&'), parent);
  if (parsed.origin !== new URL(baseURL).origin) return;
  const file = outputPath(parsed.href);
  assert.ok(existsSync(file) && statSync(file).isFile(), `引用的资源不存在：${url}`);
  assert.ok(statSync(file).size > 0, `引用的资源为空：${url}`);
}

const home = read('index.html');
assert.match(home, /<html[^>]*lang=["']?zh-CN/i, '首页缺少中文语言设置');
assert.match(home, /class=["']?article-list/, '首页未渲染文章列表');
assert.match(home, /<article\b/, '首页缺少文章卡片');
assert.match(home, /data-masonry/, '首页缺少瀑布流');
const header = home.match(/<header\b[\s\S]*?<\/header>/)?.[0];
assert.ok(header, '首页缺少页头');
assert.doesNotMatch(header, /<img\b|<svg\b/, '页头必须为纯文本');
assert.match(home, /data-color-mode/, '缺少明暗模式');
read('page/2/index.html');
read('archives/index.html');
read('search/index.html');
read('tags/index.html');
read('categories/index.html');
read('links/index.html');
read('about/index.html');
read('404.html');
const rss = read('index.xml');
assert.match(rss, /<rss\b/);
assert.match(rss, /<language>zh-CN<\/language>/i);
assert.match(rss, /<item>/);
const search = JSON.parse(read('search/index.json'));
assert.ok(Array.isArray(search) && search.length > 0, '搜索索引为空');
for (const article of search) {
  const url = new URL(article.permalink, baseURL);
  const html = readFileSync(path.join(outputPath(url.href), 'index.html'), 'utf8');
  assert.match(html, /class=["']?prose/, `文章缺少正文：${article.title}`);
  if (article.image) localAsset(article.image);
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    localAsset(match[1] || match[2] || match[3]);
  }
}
const styles = [...home.matchAll(/<link\b[^>]*href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
  .map(match => match[1] || match[2] || match[3]).filter(url => url.endsWith('.css'));
assert.ok(styles.length > 0, '首页缺少样式文件');
styles.forEach(style => localAsset(style));
for (const style of styles) {
  const cssURL = new URL(style, baseURL);
  const css = readFileSync(outputPath(cssURL.href), 'utf8');
  for (const match of css.matchAll(/url\(["']?([^\s"')]+)["']?\)/g)) localAsset(match[1], cssURL.href);
}
// 遍历所有页面，覆盖分页、分类、别名跳转和模板引用的本地资源。
const htmlFiles = readdirSync(destination, { recursive: true }).filter(file => file.endsWith('.html'));
for (const relative of htmlFiles) {
  const html = read(relative);
  for (const match of html.matchAll(/<(?:img|script)\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    localAsset(match[1] || match[2] || match[3]);
  }
  for (const match of html.matchAll(/<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const href = match[1] || match[2] || match[3];
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const target = outputPath(href);
    assert.ok(existsSync(target), `内部链接不存在：${relative} → ${href}`);
  }
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:stack\.(?:min\.)?(?:js|css)|highlight\.min\.js)/i, '仍加载旧主题资源');
}
assert.match(read('p/binder-saomang/index.html'), /class=["']?copy-code/, '代码块缺少复制按钮');
assert.match(read('p/rin/index.html'), /markdown-alert/, '提示块未渲染');
assert.equal((rss.match(/<item>/g) || []).length, search.length, 'RSS 与搜索收录的文章数不一致');
console.log(`构建验证通过：${search.length} 篇文章，${htmlFiles.length} 个页面；模板、链接、脚本、字体、图片与 RSS 均通过。产物：${destination}`);
