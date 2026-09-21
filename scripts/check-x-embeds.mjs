import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const articleURL = new URL('p/ai-random-thoughts/', baseURL).href;
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-x-static-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const errors = [];
const remoteRequests = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (/platform\.twitter\.com|syndication\.twitter\.com|\.twimg\.com/.test(request.url())) remoteRequests.push(request.url());
});

try {
  await page.goto(articleURL);
  const card = page.locator('[data-x-static]');
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.count(), 1);
  assert.equal(await page.locator('[data-x-embed], .x-embed iframe').count(), 0);
  assert.match(await card.locator('.x-embed-content').innerText(), /world’s first Fly Language Model/);
  assert.equal(await card.locator('.x-embed-source a').getAttribute('href'), 'https://x.com/nftechie_/status/2098532090874560815');
  assert.deepEqual(remoteRequests, [], '静态 X 引用不得访问 Twitter/X 资源');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不得横向溢出');
  await card.screenshot({ path: path.join(artifacts, 'mobile-light.png') });

  await page.locator('button[data-color-mode="dark"]').click();
  assert.equal(await card.isVisible(), true);
  assert.deepEqual(remoteRequests, [], '切换主题不得请求 X 组件');
  await card.screenshot({ path: path.join(artifacts, 'mobile-dark.png') });

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(articleURL);
  assert.equal(await noJS.locator('[data-x-static]').isVisible(), true);
  assert.match(await noJS.locator('.x-embed-content').innerText(), /world’s first Fly Language Model/);
  const rss = await noJS.request.get(new URL('index.xml', baseURL).href);
  assert.match(await rss.text(), /world’s first Fly Language Model/);
  await noJS.close();
  assert.deepEqual(errors, []);
  console.log(`X 静态引用检查通过：零第三方请求、浅深色、手机布局、无 JavaScript 与 RSS。产物：${artifacts}`);
} finally { await browser.close(); }
