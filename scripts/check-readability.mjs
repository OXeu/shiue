import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-readability-'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await context.newPage();

// 对实际渲染的文字和逐层合成后的背景计算 WCAG 对比度，不依赖令牌值。
async function auditText() {
  return page.evaluate(() => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const over = (front, back) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
    const luminance = rgb => rgb.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const background = el => {
      const layers = [];
      for (let node = el; node; node = node.parentElement) layers.unshift(rgba(getComputedStyle(node).backgroundColor));
      return layers.reduce((back, front) => over(front, back), [255, 255, 255]);
    };
    const failures = [];
    let minimum = Infinity;
    let count = 0;
    const check = (el, style, text) => {
      const bg = background(el);
      const fg = over(rgba(style.color), bg);
      const light = luminance(fg);
      const dark = luminance(bg);
      const ratio = (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05);
      const size = parseFloat(style.fontSize);
      const threshold = size >= 24 || (size >= 18.667 && parseInt(style.fontWeight, 10) >= 700) ? 3 : 4.5;
      minimum = Math.min(minimum, ratio);
      count++;
      if (ratio < threshold) failures.push({ tag: el.tagName, class: el.className, text: text.slice(0, 60), ratio: +ratio.toFixed(2), threshold });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!node.textContent.trim() || el.closest('script, style, noscript, [aria-hidden="true"], .sr-only, .skip-link')) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      check(el, getComputedStyle(el), node.textContent.trim());
    }
    for (const input of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
      if (input.checkVisibility()) check(input, getComputedStyle(input, '::placeholder'), input.placeholder);
    }
    return { failures, minimum: +minimum.toFixed(2), count };
  });
}

try {
  let checked = 0;
  let minimum = Infinity;
  for (const mode of ['light', 'dark']) {
    await page.goto(baseURL);
    await page.evaluate(mode => localStorage.setItem('xeu-color-mode', mode), mode);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['', 'page/2/', 'archives/', 'tags/', 'categories/', 'links/', 'about/', 'search/?keyword=Binder', '404.html', 'p/rin/', 'p/binder-saomang/']) {
        await page.goto(new URL(route, baseURL).href, { waitUntil: 'load' });
        await page.locator('main h1').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (route.startsWith('search/')) await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('找到'));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await auditText();
        assert.deepEqual(result.failures, [], `${mode} / ${width}px / ${route || '首页'} 文字对比度不足`);
        assert.ok(result.count > 0);
        checked += result.count;
        minimum = Math.min(minimum, result.minimum);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} 横向溢出`);
        if (mode === 'light' && ['', 'archives/', 'tags/', 'p/rin/', 'search/?keyword=Binder'].includes(route)) {
          await page.screenshot({ path: path.join(artifacts, `${route.split('/')[0] || 'home'}-${width}.png`) });
        }
      }
    }
    // 现有文章未必包含每种提示，使用真实样式渲染完整语义色集合。
    await page.goto(new URL('p/rin/', baseURL).href);
    await page.evaluate(() => {
      const container = document.querySelector('.prose');
      for (const type of ['note', 'tip', 'warning', 'caution', 'important']) {
        const alert = document.createElement('aside');
        alert.className = `markdown-alert alert-${type}`;
        alert.innerHTML = `<p class="alert-title">${type}</p><p>提示正文 <a href="#main">相关链接</a> <code>inline code</code></p>`;
        container.prepend(alert);
      }
    });
    assert.deepEqual((await auditText()).failures, [], `${mode} 提示块对比度不足`);
    assert.deepEqual((await auditText()).failures, [], `${mode} 外观选项对比度不足`);
    await page.goto(new URL('search/', baseURL).href);
    await page.locator('#search-input').focus();
    const focus = await page.locator('.search-form').evaluate(el => getComputedStyle(el).outlineStyle);
    assert.equal(focus, 'solid', '搜索框必须有清晰的键盘焦点');
    await page.locator('.search-form button').hover();
    assert.deepEqual((await auditText()).failures, [], `${mode} 按钮悬停对比度不足`);
  }
  console.log(`可读性检查通过：${checked} 个文字节点，最低对比度 ${minimum}:1；浅色/深色、桌面/手机、五类提示与按钮悬停。截图：${artifacts}`);
} finally {
  await browser.close();
}
