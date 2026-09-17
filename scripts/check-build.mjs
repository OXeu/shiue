import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareImages } from './prepare-images.mjs';
import { isBlurhashValid } from 'blurhash';
import sharp from 'sharp';
import { load } from 'cheerio';
import { prepareIdentity, readIdentity, identityAssets } from './deploy/identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Build verification can reuse validated generated files; a clean checkout
// needs one download. Production deployments always refresh in the identity step.
let identity;
try { identity = await readIdentity(root); }
catch { identity = await prepareIdentity({ root }); }
const images = await prepareImages(root);
for (const [source, image] of Object.entries(images)) {
  assert.ok(isBlurhashValid(image.blurhash).result, `BlurHash 无效：${source}`);
  for (const variant of image.variants) {
    const metadata = await sharp(path.join(root, 'static', variant.src), { animated: true }).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, variant.width, `缩略图尺寸不符：${source}`);
    assert.ok(variant.width <= 1440 && variant.width <= image.width, '缩略图不得放大原图');
  }
}
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
  env: { ...process.env, SHIUE_IMAGES_READY: '1', HUGO_RESOURCEDIR: path.join(output, 'resources') },
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
const $home = load(home);
assert.equal($home('link[rel="icon"]').length, 5, '缺少多尺寸 favicon');
for (const element of $home('link[rel="icon"], link[rel="apple-touch-icon"]').toArray()) {
  const src = $home(element).attr('href');
  assert.ok(src.includes(`/site-identity/${identity.fingerprint}/`), '站点图标必须使用当次头像指纹');
  localAsset(src);
}
assert.equal($home('link[rel="apple-touch-icon"]').attr('sizes'), '180x180');
assert.equal($home('meta[property="og:image"]').attr('content'), new URL(identity.socialImage.src, baseURL).href);
for (const asset of identityAssets(identity)) {
  localAsset(new URL(asset.src, baseURL).href);
  if (asset.size) {
    const metadata = await sharp(path.join(destination, asset.src)).metadata();
    assert.equal(metadata.width, asset.size);
    assert.equal(metadata.height, asset.size);
  }
}
assert.ok(statSync(path.join(destination, 'favicon.ico')).size > 0);
assert.ok(statSync(path.join(destination, 'avatar.jpg')).size > 0);
assert.doesNotMatch(home, /favicon\.svg/);
assert.match(home, /<html[^>]*lang=["']?zh-CN/i, '首页缺少中文语言设置');
assert.match(home, /class=["']?article-list/, '首页未渲染文章列表');
assert.match(home, /<article\b/, '首页缺少文章卡片');
assert.match(home, /data-masonry/, '首页缺少瀑布流');
function checkCardImages(html) {
  const cards = [...html.matchAll(/<article\b[^>]*class=["']?post-card\b[\s\S]*?<\/article>/g)];
  for (const [index, [card]] of cards.entries()) {
    const img = card.match(/<img\b[^>]*>/)?.[0];
    if (!img) continue;
    assert.match(img, index === 0 ? /loading=["']?eager\b/ : /loading=["']?lazy\b/, '仅首张卡片封面立即加载');
    if (index === 0) {
      assert.match(img, /fetchpriority=["']?high\b/, '首张封面应高优先级加载');
      assert.doesNotMatch(img, /sizes=["']?auto\b/, '立即加载的图片不能使用 sizes=auto');
    } else assert.doesNotMatch(img, /fetchpriority=["']?high\b/, '其他封面不应抢占高优先级');
    if (img.includes('srcset=')) {
      assert.match(img, /\bwidth=/, '必须保留预留尺寸');
      assert.match(img, /\bheight=/, '必须保留预留尺寸');
    }
  }
}
checkCardImages(home);
const firstCover = home.match(/<img\b[^>]*>/)?.[0];
assert.match(firstCover, /480\.webp 480w/, '首页封面缺少 480px 档位');
assert.match(firstCover, /768\.webp 768w/, '首页封面缺少 768px 档位');
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
const friends = JSON.parse(readFileSync(path.join(root, 'data/friends.json'), 'utf8'));
const friendHTML = read('友链/index.html');
assert.equal((friendHTML.match(/class=["']?friend-card(?:\s|>|["'])/g) || []).length, friends.length, '友链页条目数与数据不一致');
const friendIcons = [...friendHTML.matchAll(/<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
  .map(match => match[1] || match[2] || match[3]);
assert.equal(friendIcons.length, friends.length, '每条友链都应有本地图标');
for (const src of friendIcons) {
  assert.ok(src.startsWith(`${new URL(baseURL).pathname}friends/`), `友链图标未本地化或缺少子路径：${src}`);
  localAsset(src);
}
const healthFile = path.join(root, 'data/xeu/friend-health.json');
const healthSites = existsSync(healthFile) ? JSON.parse(readFileSync(healthFile, 'utf8')).sites : {};
const awayCount = friends.filter(friend => (healthSites?.[friend.website]?.health ?? friend.health)).length;
assert.equal((friendHTML.match(/friend-card--away/g) || []).length, awayCount, '暂离分组应使用最近检测状态');
if (awayCount) assert.match(friendHTML, /暂时离开/, '异常友链应保留在暂离分组');
assert.doesNotMatch(friendHTML, /迁移时暂不可用|迁移时状态/, '友链页不应再显示迁移文案');
const $about = load(read('about/index.html'));
assert.equal($about('.site-avatar').length, 1);
assert.equal($about('.site-avatar').attr('width'), '80');
assert.equal($about('.site-avatar').attr('sizes'), '80px');
assert.match($about('.site-avatar').attr('src'), /\/avatar-80\.webp$/);
assert.match($about('.site-avatar').attr('srcset'), /avatar-160\.webp 160w/);
assert.match($about('.site-avatar').attr('srcset'), /avatar-240\.webp 240w/);
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
  if (article.image) {
    localAsset(article.image);
    assert.match(article.image, /\/xeu-images\/.*\.webp$/, '搜索结果不应加载原图');
    assert.ok(isBlurhashValid(article.imageData.blurhash).result);
    localAsset(article.imageData.original);
    assert.ok(article.imageData.sizes.startsWith('auto, '), '搜索封面应保留懒加载自动尺寸');
    if (article.imageData.width >= 768) assert.match(article.imageData.srcset, /768\.webp 768w/, '搜索结果缺少中间档位');
    for (const candidate of article.imageData.srcset.split(', ')) {
      const [src, width] = candidate.split(' ');
      localAsset(src);
      assert.ok(parseInt(width, 10) <= 960, '列表缩略图过大');
    }
  }
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
  const $ = load(html);
  // 别名跳转页没有主题资源；所有实际页面都应在 CSS/脚本之前发现字体。
  if ($('link[rel="stylesheet"]').length) {
    const font = $('head link[rel="preload"][as="font"]');
    assert.equal(font.length, 1, `${relative} 应且仅应预加载一个正文所用字体`);
    assert.equal(new URL(font.attr('href'), baseURL).href, new URL('fonts/cantarell-latin-400.woff2', baseURL).href, `${relative} 字体预加载路径错误`);
    assert.equal(font.attr('type'), 'font/woff2');
    assert.ok(['', 'anonymous'].includes(font.attr('crossorigin')), '字体预加载必须与 @font-face 使用相同的 CORS 模式');
    localAsset(font.attr('href'));
    const head = $('head').children().toArray();
    const firstDependency = $('head script[src], head link[rel="stylesheet"]').first().get(0);
    assert.ok(head.indexOf(font.get(0)) < head.indexOf(firstDependency), `${relative} 字体应先于 CSS 和脚本预加载`);
  }
  checkCardImages(html);
  for (const match of html.matchAll(/<(?:img|script)\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    localAsset(match[1] || match[2] || match[3]);
  }
  for (const match of html.matchAll(/\bsrcset="([^"]+)"/g)) {
    match[1].split(',').forEach(candidate => localAsset(candidate.trim().split(/\s+/)[0]));
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
assert.match(read('p/rin/index.html'), /data-original=/, '正文缺少按需加载原图地址');
assert.match(home, /data-blurhash=/, '缺少 BlurHash 占位数据');
assert.equal((rss.match(/<item>/g) || []).length, search.length, 'RSS 与搜索收录的文章数不一致');
console.log(`构建验证通过：${search.length} 篇文章，${htmlFiles.length} 个页面；模板、链接、脚本、字体、图片与 RSS 均通过。产物：${destination}`);
