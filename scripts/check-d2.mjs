import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const articleURL = new URL('p/ssg-blog-comment/', baseURL).href;
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-d2-static-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const engineRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (/@d2lang|d2[^/]*\.wasm|mermaid-engine|cdn\.jsdelivr\.net\/npm\/mermaid/.test(request.url())) engineRequests.push(request.url());
});
const block = page.locator('[data-d2]').first();
const activeSVG = () => block.locator('[data-d2-active]');

try {
  await page.goto(baseURL);
  assert.equal(await page.locator('[data-d2-script]').count(), 0);
  await page.goto(articleURL);
  await block.scrollIntoViewIfNeeded();
  assert.equal(await block.locator('[data-d2-output] > svg').count(), 2, 'SSG 应内联浅深两份 SVG');
  assert.equal(await block.locator('[data-d2-hint]').count(), 0, '不再显示图表手势提示');
  assert.equal(await activeSVG().getAttribute('data-d2-render-theme'), 'light');
  assert.equal(await block.locator('.d2-source').getAttribute('open'), null);
  assert.match(await activeSVG().textContent(), /读者提交评论/);
  const nodeFill = () => activeSVG().locator('.shape > rect, .shape > path').first().evaluate(node => getComputedStyle(node).fill);
  const lightFill = await nodeFill();
  assert.notEqual(lightFill, 'none', '浅色 SVG 应渲染节点填充');
  assert.deepEqual(engineRequests, [], '页面不得下载 D2 WASM 或 Mermaid 渲染引擎');
  await block.screenshot({ path: path.join(artifacts, 'desktop-light.png') });

  await page.locator('button[data-color-mode="dark"]').click();
  await page.waitForFunction(() => document.querySelector('[data-d2-active]')?.dataset.d2RenderTheme === 'dark');
  assert.notEqual(await nodeFill(), lightFill, '深色 SVG 应使用独立的 D2 主题');
  assert.equal(await block.locator('[data-d2-output] > svg').count(), 2, '主题切换不得新增 SVG');
  await block.screenshot({ path: path.join(artifacts, 'desktop-dark.png') });

  await page.locator('button[data-color-mode="auto"]').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.querySelector('[data-d2-active]')?.dataset.d2RenderTheme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.querySelector('[data-d2-active]')?.dataset.d2RenderTheme === 'light');

  await page.setViewportSize({ width: 390, height: 844 });
  await block.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不可横向溢出');
  assert.equal(await block.locator('[data-d2-controls]:visible').count(), 1, '图表应提供缩放工具');
  const diagram = block.locator('[data-d2-output]');
  const transform = await activeSVG().evaluate(svg => svg.style.transform);
  await diagram.focus();
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await activeSVG().evaluate(svg => svg.style.transform), transform, '方向键应移动图表');
  await block.screenshot({ path: path.join(artifacts, 'mobile-light.png') });

  const source = await page.locator('.language-d2').textContent();
  await page.locator('.d2-source > summary').click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.d2-source .copy-code').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(articleURL);
  assert.equal(await noJS.locator('[data-d2-output]').isVisible(), true, '无 JavaScript 时仍应显示静态图');
  assert.equal(await noJS.locator('[data-d2-output] > svg').count(), 2);
  assert.equal(await noJS.locator('.d2-source').getAttribute('open'), null);
  assert.equal(await noJS.locator('.language-d2').textContent(), source);
  await noJS.close();
  assert.deepEqual(engineRequests, []);
  assert.deepEqual(errors, []);
  console.log(`D2 SSG 检查通过：双主题静态 SVG、零渲染引擎请求、主题切换、手机布局、缩放增强、精简提示、源码复制与无 JavaScript。截图：${artifacts}`);
} finally {
  await browser.close();
}
