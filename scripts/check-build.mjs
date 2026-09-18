import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareImages } from './prepare-images.mjs';
import { isBlurhashValid } from 'blurhash';
import sharp from 'sharp';
import { load } from 'cheerio';
import { prepareIdentity, readIdentity, identityAssets } from './deploy/identity.mjs';
import { openCommentEmail, sealComment } from '../server/comments/email.js';

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
// 测试留言只写入临时文章副本，不改写真实仓库或发布数据。
const testContent = path.join(output, 'content');
cpSync(path.join(root, 'content'), testContent, { recursive: true });
const mermaidDirectory = path.join(testContent, 'post/mermaid-render-check');
mkdirSync(mermaidDirectory, { recursive: true });
const mermaidSource = 'flowchart LR\n  A["<img src=x onerror=alert(1)> & 示例"] --> B["完成"]';
writeFileSync(path.join(mermaidDirectory, 'index.md'), [
  '---', 'title: Mermaid 渲染验证', 'slug: mermaid-render-check', 'date: 2020-01-01',
  'description: 验证图表源码转义与按页加载。', '---', '',
  '```mermaid', mermaidSource, '```', '',
  '```javascript', 'console.log("普通代码块仍可高亮和复制");', '```', '',
].join('\n'));
const commentDirectory = path.join(testContent, 'post/ai-random-thoughts/comments');
mkdirSync(commentDirectory, { recursive: true });
const fixtureComment = { id: 'e2ae8335-89b2-4f10-97db-cdb4603d23f4', path: new URL('p/ai-random-thoughts/', baseURL).pathname, name: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>\n纯文本评论', createdAt: '2026-09-17T20:00:00.000Z' };
const fixtureComments = [fixtureComment];
for (let depth = 1; depth <= 6; depth++) {
  fixtureComments.push({ ...fixtureComment, id: `e2ae8335-89b2-4f10-97db-${String(depth).padStart(12, '0')}`, parentId: fixtureComments.at(-1).id, name: `第 ${depth} 层读者`, message: `第 ${depth} 层回复\n${'很长的纯文本留言'.repeat(20)}`, createdAt: `2026-09-17T20:00:0${depth}.000Z` });
}
const orphan = { ...fixtureComment, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321', parentId: 'fe251682-6cc0-40df-bf31-6d48c12a985c', name: '保留的回复', message: '父留言删除后仍可阅读' };
fixtureComments.push(orphan);
const fixtureEmail = 'build-private-reader@example.org';
const fixtureEmailSecret = 'build-email-test-key'.repeat(3);
for (const comment of fixtureComments) writeFileSync(path.join(commentDirectory, `${comment.id}.json`), JSON.stringify(comment.id === fixtureComment.id ? sealComment({ ...comment, email: fixtureEmail }, fixtureEmailSecret) : comment));
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
  env: { ...process.env, SHIUE_IMAGES_READY: '1', HUGO_CONTENTDIR: testContent, HUGO_RESOURCEDIR: path.join(output, 'resources') },
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
  assert.doesNotMatch(pathname, /\p{Script=Han}/u, `站内路径不能包含中文：${url}`);
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
assert.equal($home('[data-mermaid-script]').length, 0, '没有图表的首页不得加载 Mermaid');
const $mermaid = load(read('p/mermaid-render-check/index.html'));
assert.equal($mermaid('[data-mermaid]').length, 1);
assert.equal($mermaid('.mermaid-source[open] code').text().trim(), mermaidSource, '图表源码应逐字保留并默认可读');
assert.equal($mermaid('.mermaid-source img, .mermaid-source script').length, 0, '图表源码必须转义');
assert.equal($mermaid('[data-mermaid-output][hidden]').length, 1);
assert.equal($mermaid('[data-mermaid-controls][hidden]').length, 1, '缩放控件只在图表可交互时显示');
assert.equal($mermaid('[data-mermaid-controls] button[type="button"][aria-label]').length, 2);
assert.equal($mermaid('[data-mermaid-action="fit"]').length, 1);
assert.equal($mermaid('.mermaid-source .copy-code').length, 1);
assert.equal($mermaid('.prose > .code-block .copy-code').length, 1, '普通代码块不受影响');
const mermaidScript = $mermaid('script[data-mermaid-script][type="module"]');
assert.equal(mermaidScript.length, 1);
localAsset(mermaidScript.attr('src'));
const loader = readFileSync(outputPath(mermaidScript.attr('src')), 'utf8');
const engineURL = loader.match(/[^"'\s]*\/js\/mermaid-engine\.[a-f0-9]+\.js/)?.[0];
assert.ok(engineURL, '加载器必须引用带内容指纹的本地 Mermaid 引擎');
localAsset(engineURL);
assert.ok(loader.includes('import('), '引擎应动态加载');
const $rssMermaid = load(read('index.xml'), { xmlMode: true });
const mermaidItem = $rssMermaid('item').filter((_, item) => $rssMermaid(item).find('link').text().endsWith('/p/mermaid-render-check/'));
assert.equal(mermaidItem.length, 1);
const rssDiagram = load(mermaidItem.find('description').text());
const rssLines = text => text.trim().split('\n').map(line => line.trimStart());
assert.deepEqual(rssLines(rssDiagram('.language-mermaid').text()), rssLines(mermaidSource), 'RSS 应保留可读的图表语句');
assert.equal(rssDiagram('script').length, 0, 'RSS 不加载图表脚本');
const authorLink = $home('.site-footer > p > a').first();
assert.equal(authorLink.text(), 'Xeu', '版权信息中的作者名称应保留');
assert.equal(authorLink.attr('href'), 'https://github.com/OXeu', '版权信息中的作者应链接至 GitHub 主页');
assert.match(authorLink.attr('rel'), /\bnoopener\b/);
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
assert.equal($home('.site-nav a').filter((_, link) => $home(link).text() === '友链').attr('href'), new URL('links/', baseURL).pathname);
for (const [route, title, count] of [
  ['categories/tech', '技术文章', 2], ['categories/essays', '随笔', 2],
  ['tags/blog', '博客', 3], ['tags/router', '路由器', 1],
  ['tags/networking', '组网', 1], ['tags/plugins', '插件化', 1],
  ['tags/async-programming', '异步编程', 1],
]) {
  const $term = load(read(`${route}/index.html`));
  assert.equal($term('h1').text().replace(/^#\s*/, ''), title, '英文路径应保留分类、标签的中文显示名称');
  assert.ok($term('.post-card').length >= count, `${route} 的文章关联丢失`);
}
const friends = JSON.parse(readFileSync(path.join(root, 'data/friends.json'), 'utf8'));
const friendHTML = read('links/index.html');
const $friendPage = load(friendHTML);
const $friendForm = $friendPage('[data-friend-form]');
assert.equal($friendForm.attr('data-endpoint'), '/api/submissions');
assert.equal($friendForm.find('fieldset[disabled]').length, 1, '无脚本时申请按钮应禁用');
assert.equal($friendForm.find('[name="consent"][required]').length, 1);
for (const field of ['title', 'website', 'description']) assert.equal($friendForm.find(`[name="${field}"][required]`).length, 1);
localAsset($friendForm.attr('data-pow-worker'));
const $friendReview = load(read('friend-review/index.html'));
assert.equal($friendReview('[data-friend-review]').attr('data-endpoint'), '/api/submissions');
assert.match($friendReview('meta[name="robots"]').attr('content'), /noindex/);
assert.equal($friendReview('[data-review-content][hidden]').length, 1);
assert.doesNotMatch(read('sitemap.xml'), /friend-review/);
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
assert.ok(search.find(article => article.permalink.endsWith('/p/rin/')).tags.includes('博客'), '搜索索引保留标签的中文名称');
const commentPages = JSON.parse(read('comment-pages.json'));
assert.ok(commentPages.some(page => page.path === fixtureComment.path));
const fixturePage = commentPages.find(page => page.path === fixtureComment.path);
assert.equal(fixturePage.directory, 'post/ai-random-thoughts');
assert.equal(openCommentEmail({ ...fixtureComment, ...fixturePage.notificationEmails[fixtureComment.id] }, fixtureEmailSecret), fixtureEmail);
for (const file of ['comment-pages.json', 'index.xml', 'search/index.json']) assert.ok(!read(file).includes(fixtureEmail), `明文邮箱不能进入 ${file}`);
for (const comment of fixtureComments) assert.ok(fixturePage.commentIds.includes(comment.id));
assert.ok(!commentPages.some(page => page.path.includes('comment-review')), '审批页不能开放评论');
const $commentsArticle = load(read('p/ai-random-thoughts/index.html'));
assert.equal($commentsArticle('[name="email"][type="email"]').length, 1);
assert.equal($commentsArticle('[name="email"][required]').length, 0, '邮箱必须可不填');
assert.equal($commentsArticle('.comment-heading-actions > [data-new-comment]').length, 1);
assert.equal($commentsArticle('#comment-editor[hidden][popover="auto"]').length, 1, '编辑面板默认隐藏');
const renderedComment = $commentsArticle(`#comment-${fixtureComment.id}`);
assert.equal(renderedComment.children('.comment-message').text(), fixtureComment.message);
assert.equal(renderedComment.children('.comment-byline').find('strong').text(), fixtureComment.name);
assert.equal(renderedComment.find('script, img').length, 0, '评论必须作为纯文本转义，不能运行 HTML');
for (const comment of fixtureComments.slice(1, -1)) {
  const node = $commentsArticle(`#comment-${comment.id}`);
  assert.equal(node.parent().parent().attr('id'), `comment-${comment.parentId}`, '回复必须挂在直接父留言下');
  assert.equal(node.children('.comment-message').text(), comment.message);
  assert.equal(node.children('.comment-byline').find('[data-reply-id]').attr('data-reply-id'), comment.id, '每一层留言的昵称、时间行中都可回复');
  assert.equal(node.children('.comment-byline').find('[data-comment-time]').attr('datetime'), comment.createdAt, '保留带时区的原始时间供浏览器转换');
  assert.equal(node.children('.comment-parent').find('a').attr('href'), `#comment-${comment.parentId}`);
}
assert.equal($commentsArticle(`#comment-${orphan.id}`).parent().hasClass('comment-replies'), false, '删除父留言后回复仍应显示');
assert.ok($commentsArticle('.comment-replies-flat').length > 0, '深层回复应限制视觉缩进');
assert.equal($commentsArticle('[name="parentId"][type="hidden"]').length, 1);
assert.equal(load(read('p/rin/index.html'))(`#comment-${fixtureComment.id}`).length, 0, '不同文章的评论不能串页');
const $review = load(read('comment-review/index.html'));
assert.match($review('meta[name="robots"]').attr('content'), /noindex/);
assert.equal($review('[data-comment-form]').length, 0);
assert.equal($review('[data-comment-review]').attr('data-endpoint'), '/api/submissions');
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
  const $article = load(html);
  for (const image of $article('img[src]').toArray()) localAsset($article(image).attr('src'));
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
for (const relative of readdirSync(destination, { recursive: true }).filter(file => /\.(?:html|xml|json)$/i.test(file))) {
  assert.doesNotMatch(decodeURIComponent(relative), /\p{Script=Han}/u, `禁止生成中文路径，包含别名页：${relative}`);
  if (relative.endsWith('.xml')) {
    const $xml = load(read(relative), { xmlMode: true });
    for (const node of $xml('loc, link, guid').toArray()) {
      const url = $xml(node).attr('href') || $xml(node).text();
      if (url && new URL(url, baseURL).origin === new URL(baseURL).origin) outputPath(url);
    }
  }
}
for (const relative of htmlFiles) {
  const html = read(relative);
  assert.ok(!html.includes(fixtureEmail), '明文邮箱不能进入公开页面');
  const $ = load(html);
  for (const link of $('link[rel="canonical"], meta[property="og:url"]').toArray()) {
    outputPath($(link).attr('href') || $(link).attr('content'));
  }
  for (const comments of $('[data-comments]').toArray()) {
    assert.equal($(comments).find('[data-comment-form]').attr('data-endpoint'), '/api/submissions', `${relative} 应使用本站评论接口`);
    localAsset($(comments).find('[data-comment-form]').attr('data-pow-worker'));
    assert.equal($(comments).find('[data-cancel-proof][hidden][type="button"]').length, 1);
    assert.equal($(comments).find('[name="consent"][required]').length, 1, '提交前必须说明公开 Git 历史');
    assert.equal($(comments).find('[name="message"][maxlength="2000"]').length, 1);
  }
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
  for (const asset of $('img[src], script[src]').toArray()) localAsset($(asset).attr('src'));
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
