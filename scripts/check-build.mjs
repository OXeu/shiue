import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareImages } from './prepare-images.mjs';
import { extractD2, prepareD2 } from './prepare-d2.mjs';
import { isBlurhashValid } from 'blurhash';
import sharp from 'sharp';
import { load } from 'cheerio';
import { prepareIdentity, readIdentity, identityAssets } from './deploy/identity.mjs';
import { openCommentEmail, sealComment } from '../server/comments/email.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(extractD2('````markdown\n```d2\nA -> B\n```\n````\n~~~d2\nC -> D\n~~~'), ['C -> D'], '文档示例中的嵌套围栏不能误触发预渲染');
for (const relative of ['hugo.toml', 'config/_default/config.toml']) {
  assert.match(readFileSync(path.join(root, relative), 'utf8'), /^baseURL\s*=\s*["']https:\/\/xeu\.life\/["']/m, `${relative} 必须声明正式站点绝对地址`);
}
// Build verification can reuse validated generated files; a clean checkout
// needs one download. Production deployments always refresh in the identity step.
let identity;
try { identity = await readIdentity(root); }
catch { identity = await prepareIdentity({ root }); }
const images = await prepareImages(root);
for (const [source, image] of Object.entries(images)) {
  assert.ok(isBlurhashValid(image.blurhash).result, `BlurHash 无效：${source}`);
  assert.deepEqual(image.variants.map(item => item.role), ['thumbnail', 'medium'], `图片角色不完整：${source}`);
  for (const variant of new Map(image.variants.map(item => [item.src, item])).values()) {
    const metadata = await sharp(path.join(root, 'static', variant.src), { animated: true }).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, variant.width, `派生图片尺寸不符：${source}`);
    assert.ok(variant.width <= 1600 && variant.width <= image.width, '派生图片不得放大原图');
  }
}
const output = mkdtempSync(path.join(tmpdir(), 'shiue-build-'));
const destination = path.join(output, 'public');
const baseURL = process.env.SHIUE_TEST_BASE_URL || 'https://example.org/';
// 测试留言只写入临时文章副本，不改写真实仓库或发布数据。
const testContent = path.join(output, 'content');
cpSync(path.join(root, 'content'), testContent, { recursive: true });
const d2Directory = path.join(testContent, 'post/d2-render-check');
mkdirSync(d2Directory, { recursive: true });
const d2Source = 'direction: right\nA: "<img src=x onerror=alert(1)> & 示例"\nB: "完成"\nA -> B';
writeFileSync(path.join(d2Directory, 'index.md'), [
  '---', 'title: D2 渲染验证', 'slug: d2-render-check', 'date: 2020-01-01',
  'description: 验证图表源码转义与按页加载。', '---', '',
  '```d2', d2Source, '```', '',
  '```javascript', 'console.log("普通代码块仍可高亮和复制");', '```', '',
  '```d2', d2Source, '```', '',
].join('\n'));
await prepareD2(root, { contentDirectory: testContent, log: () => {} });
const commentDirectory = path.join(testContent, 'post/ai-random-thoughts/comments');
mkdirSync(commentDirectory, { recursive: true });
const fixtureComment = { id: 'e2ae8335-89b2-4f10-97db-cdb4603d23f4', path: new URL('p/ai-random-thoughts/', baseURL).pathname, name: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>\n纯文本评论', createdAt: '2026-09-17T20:00:00.000Z' };
const fixtureComments = [fixtureComment];
for (let depth = 1; depth <= 6; depth++) {
  fixtureComments.push({ ...fixtureComment, id: `e2ae8335-89b2-4f10-97db-${String(depth).padStart(12, '0')}`, parentId: fixtureComments.at(-1).id, name: `第 ${depth} 层读者`, message: `第 ${depth} 层回复\n${'很长的纯文本留言'.repeat(20)}`, createdAt: `2026-09-17T20:00:0${depth}.000Z` });
}
const siblingReply = { ...fixtureComment, id: 'e2ae8335-89b2-4f10-97db-999999999999', parentId: fixtureComment.id, name: '最新的同级回复', message: '同级回复应按时间倒序显示', createdAt: '2026-09-17T20:00:09.000Z' };
fixtureComments.push(siblingReply);
const orphan = { ...fixtureComment, id: 'a380e8f6-0f53-4d32-a0a4-a48e4d2bc321', parentId: 'fe251682-6cc0-40df-bf31-6d48c12a985c', name: '保留的回复', message: '父留言删除后仍可阅读', createdAt: '2026-09-17T20:00:10.000Z' };
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
const homeScripts = $home('script[src]').map((_, element) => $home(element).attr('src')).get();
assert.equal(homeScripts.length, 2, '首页只应加载跨页过渡与文章列表两个外部脚本');
assert.ok(homeScripts.some(src => /\/js\/article-transition\.min\.[a-f0-9]+\.js$/.test(src)));
const feedScript = homeScripts.find(src => /\/js\/feed\.[a-f0-9]+\.js$/.test(src));
assert.ok(feedScript, '首页缺少按页面裁剪的文章列表脚本');
const feedPreload = $home('link[rel="preload"][as="script"]');
assert.equal(feedPreload.length, 1, '首页应预加载文章列表脚本');
assert.equal(feedPreload.attr('href'), feedScript, 'preload 必须与实际执行的首页脚本使用同一指纹地址');
assert.equal(feedPreload.attr('integrity'), $home(`script[src="${feedScript}"]`).attr('integrity'));
const colorMode = $home('head script:not([src])');
assert.equal(colorMode.length, 1, '颜色模式初始化应直接内联，避免额外阻塞请求');
assert.match(colorMode.text(), /xeu-color-mode/);
const feedBundle = readFileSync(outputPath(feedScript), 'utf8');
assert.ok(Buffer.byteLength(feedBundle) < 16_000, '首页脚本体积异常增长');
assert.match(feedBundle, /data-masonry/);
assert.match(feedBundle, /data-progressive-image/);
assert.match(feedBundle, /site-nav-toggle/);
for (const unusedFeature of ['data-search', 'data-comment-form', 'data-friend-form', 'data-zoomable', 'data-x-embed', 'turnstile']) {
  assert.doesNotMatch(feedBundle, new RegExp(unusedFeature), `首页脚本不应包含 ${unusedFeature} 功能`);
}
assert.equal($home('[data-d2-script]').length, 0, '没有图表的首页不得加载 D2 增强脚本');
const $d2 = load(read('p/d2-render-check/index.html'));
assert.equal($d2('[data-d2]').length, 2);
assert.ok($d2('.d2-source code').toArray().every(code => $d2(code).text().trim() === d2Source), '图表源码应逐字保留');
assert.equal($d2('.d2-source[open]').length, 0, 'SSG 图表成功时默认收起源码');
assert.equal($d2('.d2-source img, .d2-source script').length, 0, '图表源码必须转义');
assert.equal($d2('[data-d2-output][hidden]').length, 0, 'SSG 图表无需等待 JavaScript 即可显示');
assert.equal($d2('[data-d2-output] > svg').length, 4, '每个图表应内联已压缩的浅色和深色 SVG');
assert.equal($d2('[data-d2-render-theme="light"]').length, 2);
assert.equal($d2('[data-d2-render-theme="dark"]').length, 2);
assert.equal(new Set($d2('[data-d2-output] > svg').map((_, svg) => $d2(svg).attr('id')).get()).size, 4, '同页重复源码和浅深主题的 SVG ID 必须隔离');
assert.equal($d2('[data-d2-output] script, [data-d2-output] [onerror]').length, 0, '静态 SVG 不能包含可执行内容');
assert.doesNotMatch($d2.html(), /@font-face|data:application\/font-woff/, '静态 SVG 不应重复内嵌字体');
assert.match($d2.html(), /font-family:var\(--font-body\)/, '静态 SVG 应继承站点中文字体栈');
assert.equal($d2('[data-d2-controls][hidden]').length, 2, '缩放控件只在图表可交互时显示');
assert.equal($d2('[data-d2-controls] button[type="button"][aria-label]').length, 4);
assert.equal($d2('[data-d2-action="fit"]').length, 2);
assert.equal($d2('.d2-source .copy-code').length, 2);
assert.equal($d2('.prose > .code-block .copy-code').length, 1, '普通代码块不受影响');
const d2Script = $d2('script[data-d2-script][type="module"]');
assert.equal(d2Script.length, 1);
localAsset(d2Script.attr('src'));
const loader = readFileSync(outputPath(d2Script.attr('src')), 'utf8');
assert.ok(Buffer.byteLength(loader) < 8_000, 'D2 客户端只能保留轻量缩放增强');
assert.doesNotMatch(loader, /@d2lang|\.wasm|platform\.twitter|import\(/, '客户端不得下载 D2 渲染器、WASM 或 X 组件');
const $rssD2 = load(read('index.xml'), { xmlMode: true });
const d2Item = $rssD2('item').filter((_, item) => $rssD2(item).find('link').text().endsWith('/p/d2-render-check/'));
assert.equal(d2Item.length, 1);
const rssDiagram = load(d2Item.find('description').text());
const rssLines = text => text.trim().split('\n').map(line => line.trimStart());
assert.equal(rssDiagram('.language-d2').length, 2);
assert.ok(rssDiagram('.language-d2').toArray().every(code => rssLines(rssDiagram(code).text()).join('\n') === rssLines(d2Source).join('\n')), 'RSS 应保留可读的图表语句');
assert.equal(rssDiagram('[data-d2-render-theme]').length, 0, 'RSS 不应重复内联双主题 SVG');
assert.equal(rssDiagram('script').length, 0, 'RSS 不加载图表脚本');
const authorLink = $home('.site-footer > p > a').first();
assert.equal(authorLink.text(), 'Xeu', '版权信息中的作者名称应保留');
assert.equal(authorLink.attr('href'), 'https://github.com/OXeu', '版权信息中的作者应链接至 GitHub 主页');
assert.match(authorLink.attr('rel'), /\bnoopener\b/);
assert.equal($home('link[rel="icon"]').length, 5, '缺少多尺寸 favicon');
assert.equal($home('link[rel="icon"][type="image/webp"]').length, 4, '浏览器图标应使用 WebP');
for (const element of $home('link[rel="icon"], link[rel="apple-touch-icon"]').toArray()) {
  const src = $home(element).attr('href');
  assert.ok(src.includes(`/site-identity/${identity.fingerprint}/`), '站点图标必须使用当次头像指纹');
  localAsset(src);
}
assert.equal($home('link[rel="apple-touch-icon"]').attr('sizes'), '180x180');
assert.ok(identity.favicons.every(asset => asset.src.endsWith('.webp')));
assert.ok(identity.touchIcon.src.endsWith('.webp'));
assert.ok(identity.appleTouchIcon.src.endsWith('.png'));
assert.ok(identity.socialImage.src.endsWith('.png'));
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
  let imageIndex = 0;
  for (const [card] of cards) {
    const img = card.match(/<img\b[^>]*>/)?.[0];
    if (!img) continue;
    assert.match(img, imageIndex === 0 ? /loading=["']?eager\b/ : /loading=["']?lazy\b/, '仅第一张实际存在的卡片封面立即加载');
    if (imageIndex === 0) {
      assert.match(img, /fetchpriority=["']?high\b/, '首张封面应高优先级加载');
      assert.doesNotMatch(img, /sizes=["']?auto\b/, '立即加载的图片不能使用 sizes=auto');
    } else assert.doesNotMatch(img, /fetchpriority=["']?high\b/, '其他封面不应抢占高优先级');
    assert.doesNotMatch(img, /\bsrcset=/, '列表只能加载小图，不能候选正文中图');
    assert.match(img, /\/xeu-images\/[a-f0-9]+-640\.webp/, '列表应使用 640px 小图');
    assert.match(img, /\bwidth=/, '必须保留预留尺寸');
    assert.match(img, /\bheight=/, '必须保留预留尺寸');
    imageIndex++;
  }
}
checkCardImages(home);
const firstCover = home.match(/<img\b[^>]*>/)?.[0];
assert.match(firstCover, /-640\.webp/, '首页封面必须使用小图');
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
assert.equal($friendForm.find('[data-turnstile][hidden]').length, 1);
assert.equal($friendForm.attr('data-pow-worker'), undefined);
const $friendReview = load(read('friend-review/index.html'));
assert.equal($friendReview('[data-friend-review]').attr('data-endpoint'), '/api/submissions');
assert.match($friendReview('meta[name="robots"]').attr('content'), /noindex/);
assert.equal($friendReview('[data-review-content][hidden]').length, 1);
assert.equal($friendReview('script:not([src])').length, 0, '友链审核页不能包含 CSP 会阻止的内联脚本');
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
assert.equal($commentsArticle('[data-x-static]').length, 1, 'X 帖子应在 SSG 阶段生成静态引用卡片');
assert.equal($commentsArticle('[data-x-embed], .x-embed iframe').length, 0, 'X 帖子不得保留动态组件或 iframe');
assert.match($commentsArticle('.x-embed-content').text(), /world’s first Fly Language Model/);
assert.equal($commentsArticle('.x-embed-source a').attr('href'), 'https://x.com/nftechie_/status/2098532090874560815');
const postScript = $commentsArticle('script[src]').map((_, script) => $commentsArticle(script).attr('src')).get()
  .find(src => /\/js\/post\.[a-f0-9]+\.js$/.test(src));
assert.ok(postScript, '文章页缺少按页面裁剪的脚本');
const postBundle = readFileSync(outputPath(postScript), 'utf8');
assert.doesNotMatch(postBundle, /platform\.twitter|data-x-embed|createTweet/, '文章脚本不得包含 X 动态组件');
assert.equal($commentsArticle('[name="email"][type="email"]').length, 1);
assert.equal($commentsArticle('[name="email"][required]').length, 0, '邮箱必须可不填');
assert.equal($commentsArticle('.comment-heading-actions > [data-new-comment]').length, 1);
assert.equal($commentsArticle('#comment-editor[hidden][popover="auto"]').length, 1, '编辑面板默认隐藏');
const renderedComment = $commentsArticle(`#comment-${fixtureComment.id}`);
assert.equal(renderedComment.children('.comment-message').text(), fixtureComment.message);
assert.equal(renderedComment.children('.comment-byline').find('strong').text(), fixtureComment.name);
assert.equal(renderedComment.find('script, img').length, 0, '评论必须作为纯文本转义，不能运行 HTML');
assert.deepEqual(
  $commentsArticle('.comments > .comment-list > .comment-item').map((_, item) => item.attribs.id).get(),
  [`comment-${orphan.id}`, `comment-${fixtureComment.id}`],
  '顶层评论应按时间倒序显示',
);
assert.deepEqual(
  renderedComment.children('.comment-replies').children('.comment-item').map((_, item) => item.attribs.id).get(),
  [`comment-${siblingReply.id}`, `comment-${fixtureComments[1].id}`],
  '同一父评论下的回复应按时间倒序显示',
);
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
assert.equal($review('script:not([src])').length, 0, '评论审核页不能包含 CSP 会阻止的内联脚本');
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
    assert.equal(article.imageData.srcset, undefined, '搜索封面不能暴露正文中图候选');
    assert.match(article.image, /-640\.webp$/, '搜索封面应使用 640px 小图');
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
    const url = $(link).attr('href') || $(link).attr('content');
    assert.match(url, /^https?:\/\//, `${relative} 的 canonical/og:url 必须是绝对网址`);
    assert.equal(new URL(url).origin, new URL(baseURL).origin, `${relative} 的 canonical/og:url 域名错误`);
    outputPath(url);
  }
  for (const comments of $('[data-comments]').toArray()) {
    assert.equal($(comments).find('[data-comment-form]').attr('data-endpoint'), '/api/submissions', `${relative} 应使用本站评论接口`);
    assert.equal($(comments).find('[data-turnstile][hidden]').length, 1);
    assert.equal($(comments).find('[data-comment-form]').attr('data-pow-worker'), undefined);
    assert.equal($(comments).find('[data-cancel-verification][hidden][type="button"]').length, 1);
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
