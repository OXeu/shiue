import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const articleURL = new URL('p/ai-random-thoughts/', baseURL).href;
const widgetsURL = 'https://platform.twitter.com/widgets.js';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-x-embeds-'));
const browser = await chromium.launch({ headless: true });
const errors = [];

// 模拟官方 API 的成功、空结果和迟到结果；回归不依赖 X 的网络或帖子状态。
const widgetStub = `
window.widgetCalls = [];
window.releaseWidgets = [];
window.twttr = { widgets: { createTweet(id, host, options) {
  window.widgetCalls.push({ id, options });
  if (window.emptyWidget) return Promise.resolve(undefined);
  const create = () => {
    const frame = document.createElement('iframe');
    frame.title = 'X 帖子';
    frame.dataset.theme = options.theme;
    frame.style.cssText = 'width:100%;height:240px';
    frame.srcdoc = '<p>X 嵌入测试</p>';
    host.append(frame);
    return frame;
  };
  if (window.delayWidget) return new Promise(resolve => window.releaseWidgets.push(() => resolve(create())));
  return Promise.resolve(create());
} } };
`;
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', error => errors.push(error.message));
let requests = 0;
const stubRoute = async route => {
  requests++;
  await route.fulfill({ contentType: 'application/javascript', body: widgetStub });
};
await page.route(widgetsURL, stubRoute);
const reveal = () => page.locator('[data-x-embed]').first().scrollIntoViewIfNeeded();

try {
  await page.goto(baseURL);
  assert.equal(requests, 0, '没有帖子时不得请求 X 脚本');

  // 同页多个帖子必须共用脚本，主题切换后不能遗留多个 iframe。
  await page.route(articleURL, async route => {
    const response = await route.fetch();
    const $ = load(await response.text());
    $('.x-embed').after($('.x-embed').clone());
    await route.fulfill({ response, body: $.html() });
  });
  await page.goto(articleURL);
  assert.equal(requests, 0, '帖子远离视口时不应加载');
  await reveal();
  await page.locator('[data-x-embed]').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('.x-embed-frame:not(.is-pending) iframe').length === 2);
  assert.equal(requests, 1, '同页脚本应只加载一次');
  assert.equal(await page.locator('.x-embed-fallback:visible').count(), 0);
  const calls = await page.evaluate(() => window.widgetCalls);
  assert.ok(calls.every(call => call.id === '2098532090874560815' && call.options.dnt && call.options.theme === 'light'));
  await page.locator('button[data-color-mode="dark"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.x-embed-frame:not(.is-pending) iframe[data-theme="dark"]').length === 2);
  assert.equal(await page.locator('.x-embed-frame iframe').count(), 2);
  assert.equal(requests, 1, '切换主题不得重复下载脚本');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不得横向溢出');
  await reveal();
  await page.screenshot({ path: path.join(artifacts, 'mobile-dark.png') });
  await page.unroute(articleURL);

  // 脚本加载失败仍保留引用、原帖链接和可阅读正文。
  await page.unroute(widgetsURL);
  let rejectedScript;
  const scriptRejected = new Promise(resolve => { rejectedScript = resolve; });
  await page.route(widgetsURL, async route => { await route.abort(); rejectedScript(); });
  await page.goto(articleURL);
  await reveal();
  await scriptRejected;
  await page.waitForFunction(() => !document.querySelector('script[src="https://platform.twitter.com/widgets.js"]'));
  assert.equal(await page.locator('.x-embed-fallback').isVisible(), true);
  assert.match(await page.locator('.x-embed-fallback').innerText(), /world’s first Fly Language Model/);
  assert.equal(await page.locator('.x-embed-source a').getAttribute('href'), 'https://x.com/nftechie_/status/2098532090874560815');
  await page.screenshot({ path: path.join(artifacts, 'network-fallback.png') });

  await page.unroute(widgetsURL);
  await page.route(widgetsURL, stubRoute);
  await page.addInitScript(() => { window.emptyWidget = true; });
  await page.goto(articleURL);
  await reveal();
  await page.waitForFunction(() => window.widgetCalls?.length === 1 && !document.querySelector('.x-embed-frame'));
  assert.equal(await page.locator('.x-embed-fallback').isVisible(), true, '帖子不可用时保留引用');

  // 快速切换主题时，旧请求返回不能覆盖新主题。
  await page.goto(articleURL);
  await page.evaluate(() => { window.emptyWidget = false; window.delayWidget = true; });
  await reveal();
  await page.waitForFunction(() => window.releaseWidgets?.length === 1);
  await page.evaluate(() => { document.documentElement.dataset.colorMode = 'light'; });
  await page.waitForFunction(() => window.releaseWidgets.length === 2);
  await page.evaluate(() => window.releaseWidgets[1]());
  await page.waitForFunction(() => document.querySelector('.x-embed-frame:not(.is-pending) iframe')?.dataset.theme === 'light');
  await page.evaluate(() => window.releaseWidgets[0]());
  await page.waitForFunction(() => document.querySelectorAll('.x-embed-frame').length === 1);
  assert.equal(await page.locator('.x-embed-frame iframe').getAttribute('data-theme'), 'light');

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(articleURL);
  assert.equal(await noJS.locator('.x-embed-fallback').isVisible(), true);
  assert.equal(await noJS.locator('.x-embed-source a').isVisible(), true);
  const rss = await noJS.request.get(new URL('index.xml', baseURL).href);
  assert.match(await rss.text(), /world’s first Fly Language Model/);
  await noJS.close();
  assert.deepEqual(errors, []);
  console.log(`X 嵌入检查通过：按需加载、脚本复用、手机布局、主题切换与竞态、网络和帖子失败、无 JS、RSS。产物：${artifacts}`);
} finally { await browser.close(); }
