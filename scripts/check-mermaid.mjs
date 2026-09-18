import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const articleURL = new URL('p/ssg-blog-comment/', baseURL).href;
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-mermaid-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let engineRequests = 0;
page.on('request', request => { if (/\/js\/mermaid-engine\./.test(request.url())) engineRequests++; });
const reveal = () => page.locator('[data-mermaid]').first().scrollIntoViewIfNeeded();
const rendered = (count, mode) => page.waitForFunction(({ count, mode }) =>
  document.querySelectorAll(`[data-mermaid-theme="${mode}"] [data-mermaid-output] > svg`).length === count,
{ count, mode });

try {
  await page.goto(baseURL);
  assert.equal(await page.locator('[data-mermaid-script]').count(), 0);
  assert.equal(engineRequests, 0, '首页不应加载引擎');
  await page.goto(articleURL);
  assert.equal(engineRequests, 0, '远离视口时不应下载引擎');
  const source = await page.locator('.language-mermaid').textContent();
  await reveal();
  await rendered(1, 'light');
  assert.equal(engineRequests, 1);
  assert.equal(await page.locator('.mermaid-source').getAttribute('open'), null);
  const lightSVG = await page.locator('[data-mermaid-output]').innerHTML();
  const nodeFill = () => page.locator('[data-mermaid-output] .node rect').first().evaluate(node => getComputedStyle(node).fill);
  assert.equal(await nodeFill(), 'rgb(247, 247, 248)', '浅色节点应使用现有主题令牌');
  assert.match(await page.locator('[data-mermaid-output]').textContent(), /读者提交评论/);
  await reveal();
  await page.locator('[data-mermaid]').screenshot({ path: path.join(artifacts, 'desktop-light.png') });

  await page.locator('button[data-color-mode="dark"]').click();
  await rendered(1, 'dark');
  assert.notEqual(await page.locator('[data-mermaid-output]').innerHTML(), lightSVG);
  assert.equal(await nodeFill(), 'rgb(36, 36, 40)', '深色节点应重新使用深色主题令牌');
  await page.locator('button[data-color-mode="auto"]').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await rendered(1, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await rendered(1, 'light');
  await page.evaluate(async () => {
    for (const mode of ['dark', 'light', 'dark', 'light', 'dark']) {
      document.documentElement.dataset.colorMode = mode;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  await rendered(1, 'dark');
  assert.equal(await page.locator('[data-mermaid-output] > svg').count(), 1, '主题切换不应遗留旧图');
  assert.equal(engineRequests, 1, '主题切换不应重复下载引擎');

  await page.setViewportSize({ width: 390, height: 844 });
  await reveal();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不可横向溢出');
  const diagram = page.locator('[data-mermaid-output]');
  assert.equal(await page.locator('[data-mermaid-controls]:visible').count(), 1, '图表应提供缩放工具');
  const transform = await diagram.locator('svg').evaluate(svg => svg.style.transform);
  await diagram.focus();
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await diagram.locator('svg').evaluate(svg => svg.style.transform), transform, '方向键应移动图表');
  await page.locator('[data-mermaid]').screenshot({ path: path.join(artifacts, 'mobile-dark.png') });

  await page.locator('.mermaid-source > summary').click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.mermaid-source .copy-code').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);

  // 使用真实 Mermaid 引擎验证同页多种图、解析失败隔离和不可信标签。
  await page.route(articleURL, async route => {
    const response = await route.fetch();
    const $ = load(await response.text());
    const fixture = $('[data-mermaid]').first().clone();
    const diagramSource = text => {
      const node = fixture.clone();
      node.find('code').text(text);
      return node;
    };
    $('.article .prose').empty().append(
      diagramSource('flowchart LR\n A["First"] --> B["Second"]'),
      diagramSource('sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi'),
      diagramSource('this is not a diagram'),
      diagramSource('flowchart LR\n A["<img src=x onerror=alert(1)>"] --> B["Safe"]\n click B "javascript:alert(1)"'),
    );
    await route.fulfill({ response, body: $.html() });
  });
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(articleURL);
  await page.locator('[data-mermaid]').last().scrollIntoViewIfNeeded();
  await rendered(3, 'light');
  assert.equal(engineRequests, 2, '同页多图应共用一次引擎加载');
  assert.equal(await page.locator('[data-mermaid-status]:visible').count(), 1, '坏图不应阻止其他图渲染');
  assert.equal(await page.locator('.mermaid-source[open]').count(), 1, '坏图保留源码');
  assert.equal(await page.locator('[data-mermaid-output] script, [data-mermaid-output] [onerror]').count(), 0);
  const links = await page.locator('[data-mermaid-output] a').evaluateAll(nodes => nodes.map(node =>
    node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || ''));
  assert.ok(links.every(href => !/^\s*javascript:/i.test(href)), '图表链接不得执行脚本');
  const ids = await page.locator('[data-mermaid-output] > svg').evaluateAll(nodes => nodes.map(node => node.id));
  assert.equal(new Set(ids).size, 3, '多个图表的 SVG ID 必须唯一');
  assert.equal(await page.locator('body > div[id^="dxeu-mermaid-"]').count(), 0, '失败图不得遗留临时节点');
  await page.unroute(articleURL);

  // 加载失败仍展示原始源码，不让异常打断页面其他交互。
  await page.route('**/js/mermaid-engine.*.js', route => route.abort());
  await page.goto(articleURL);
  await reveal();
  await page.locator('[data-mermaid-status]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.language-mermaid').textContent(), source);
  assert.equal(await page.locator('.mermaid-source[open]').count(), 1);
  assert.equal(await page.locator('[data-mermaid-output]:visible').count(), 0);
  await page.unroute('**/js/mermaid-engine.*.js');

  const fallback = await browser.newPage();
  await fallback.addInitScript(() => { delete window.IntersectionObserver; });
  await fallback.goto(articleURL);
  await fallback.waitForSelector('[data-mermaid-output] svg');
  await fallback.close();

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(articleURL);
  assert.equal(await noJS.locator('.mermaid-source[open]').count(), 1);
  assert.equal(await noJS.locator('.language-mermaid').textContent(), source);
  assert.equal(await noJS.locator('[data-mermaid-output]').isVisible(), false);
  await noJS.close();
  assert.deepEqual(errors, []);
  console.log(`Mermaid 浏览器检查通过：实际架构图、按需加载、多图、浅深色与系统主题、切换竞态、手机布局、键盘平移、源码复制、安全转义、语法和网络失败、无 JS。截图：${artifacts}`);
} finally {
  await browser.close();
}
