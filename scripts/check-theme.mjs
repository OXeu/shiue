import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 浏览器检查为可选步骤；主题构建本身不需要安装 Playwright。
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'shiue-browser-'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const open = route => page.goto(new URL(route, baseURL).href, { waitUntil: 'load' });

async function checkLayout() {
  await page.waitForFunction(() => !document.querySelector('[data-masonry]') || document.querySelector('[data-masonry]').classList.contains('is-masonry'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.post-card')].map(card => card.getBoundingClientRect().toJSON()),
    container: document.querySelector('[data-masonry]')?.getBoundingClientRect().toJSON(),
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.scrollWidth <= layout.width, '页面横向溢出');
  for (const [i, a] of layout.cards.entries()) {
    assert.ok(a.bottom <= layout.container.bottom + 1, '卡片超出容器');
    for (const b of layout.cards.slice(i + 1)) {
      assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, '瀑布流卡片重叠');
    }
  }
  return new Set(layout.cards.map(card => Math.round(card.x))).size;
}

try {
  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open('');
    const columns = await checkLayout();
    assert.equal(await page.locator('.post-card').count(), 12);
    assert.equal(await page.locator('.site-header img, .site-header svg').count(), 0);
    if (width < 600) assert.equal(columns, 1);
    if (width === 1440) assert.equal(columns, 3);
    if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(artifacts, `home-${width}.png`) });
    console.log(`${width}px：${columns} 列，无重叠或横向溢出`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open('');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('html').getAttribute('data-color-mode'), 'dark');
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'light');
  await page.getByRole('link', { name: '下一页 →' }).click();
  assert.equal(await page.locator('.post-card').count(), 5);
  await checkLayout();

  await open('search/?keyword=Binder');
  await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('找到'));
  assert.ok(await page.locator('.post-card').count() >= 2);
  await checkLayout();
  await page.locator('#search-input').fill('不存在的关键词999999');
  await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('没有找到'));
  assert.equal(await page.locator('.post-card').count(), 0);
  await page.locator('#search-input').fill('<script>alert(1)</script>');
  await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('没有找到'));
  assert.equal(await page.locator('.search-status script').count(), 0);
  await page.locator('#search-input').fill('');
  await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('输入关键词'));

  for (const route of ['archives/', 'tags/', 'categories/', 'links/', 'about/', '404.html', 'p/binder-saomang/', 'p/rin/']) {
    await open(route);
    await page.waitForSelector('main h1');
    await checkLayout();
    if (route === 'p/binder-saomang/') {
      await page.locator('.copy-code').first().click();
      await page.waitForFunction(() => document.querySelector('.copy-code').textContent === '已复制');
      assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('syntax'));
    }
    if (route === 'p/rin/') {
      await page.locator('[data-zoomable]').first().click();
      assert.equal(await page.locator('dialog[open]').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      await checkLayout();
      await page.locator('.mobile-toc summary').click();
      assert.equal(await page.locator('.mobile-toc').getAttribute('open'), '');
    }
  }
  // 索引加载失败时可重试；使用同一页面验证失败不会被永久缓存。
  await page.route('**/search/index.json', route => route.fulfill({ status: 503, body: '' }));
  await open('search/?keyword=Rin');
  await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('暂时不可用'));
  await page.unroute('**/search/index.json');
  await page.locator('.search-form button').click();
  await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('找到'));

  // 失败封面隐藏后，其他卡片仍应正确排列。
  await page.route('**/images/2068feaaa441cb1fabc09145.jpg', route => route.abort());
  await open('');
  await page.waitForFunction(() => document.querySelector('.card-cover').hidden);
  await checkLayout();
  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(baseURL);
  assert.equal(await noJS.locator('.post-card').count(), 12);
  assert.ok(await noJS.locator('.card-title a').first().getAttribute('href'));
  assert.deepEqual(errors, []);
  console.log(`主题检查通过：响应式瀑布流、搜索与失败重试、分页、主题切换、正文交互及无 JS 回退。截图：${artifacts}`);
} finally {
  await browser.close();
}
