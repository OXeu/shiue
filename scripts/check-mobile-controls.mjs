import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-mobile-controls-'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const toggle = page.locator('.site-nav-toggle');
const nav = page.locator('#site-nav');
const opened = () => page.waitForFunction(() => getComputedStyle(document.querySelector('#site-nav')).opacity === '1');
const closed = () => nav.waitFor({ state: 'hidden' });

try {
  await page.goto(baseURL);
  await closed();
  assert.equal(await nav.evaluate(el => el.inert), true);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-label'), '关闭导航菜单');
  assert.equal(await nav.evaluate(el => getComputedStyle(el).visibility), 'visible', '入场应立即可见，不应等待退场延迟');
  const opening = await page.locator('.site-navigation').evaluate(el => el.getAnimations({ subtree: true })
    .map(animation => ({ property: animation.transitionProperty, pseudo: animation.effect.pseudoElement })));
  assert.ok(opening.some(animation => animation.property === 'opacity'), 'popover 必须有入场动画');
  assert.ok(opening.some(animation => animation.property === 'transform' && animation.pseudo === '::before'), '菜单线条必须过渡成关闭图标');
  await opened();
  assert.equal(await nav.evaluate(el => el.inert), false);
  await page.screenshot({ path: path.join(artifacts, 'menu-open.png') });
  await toggle.click();
  assert.equal(await nav.evaluate(el => el.inert), true, '退场期间立即阻止菜单交互');
  assert.equal(await nav.getAttribute('aria-hidden'), 'true');
  assert.ok(await nav.evaluate(el => el.getAnimations().some(animation => animation.transitionProperty === 'opacity')), 'popover 必须有退场动画');
  await closed();
  assert.equal(await toggle.getAttribute('aria-label'), '打开导航菜单');

  // 动画进行中反复反向切换，最终状态由最后一次点击决定。
  await toggle.evaluate(async el => {
    for (let i = 0; i < 5; i++) {
      el.click();
      await new Promise(resolve => setTimeout(resolve, 45));
    }
  });
  await opened();
  await toggle.focus();
  await page.keyboard.press('Tab');
  assert.ok(await nav.locator('a').first().evaluate(el => el === document.activeElement));
  await page.keyboard.press('Escape');
  assert.ok(await toggle.evaluate(el => el === document.activeElement));
  await closed();
  await page.keyboard.press('Tab');
  assert.equal(await nav.evaluate(el => el.contains(document.activeElement)), false, '收起后 Tab 不应进入菜单');
  await toggle.click();
  await opened();
  await page.locator('.page-heading h1').click();
  await closed();

  // 切换至桌面应恢复完整导航；返回手机应收起并恢复焦点。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => !document.querySelector('#site-nav').inert);
  assert.ok(await nav.isVisible());
  assert.equal(await nav.evaluate(el => el.inert), false);
  await nav.locator('a').first().focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await closed();
  assert.ok(await toggle.evaluate(el => el === document.activeElement));

  for (const width of [320, 390, 600]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.color-modes').scrollIntoViewIfNeeded();
    const bounds = await page.locator('.color-modes').evaluate(el => {
      const footer = el.closest('footer').getBoundingClientRect();
      const group = el.getBoundingClientRect();
      const buttons = [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return { center: (buttons[0].left + buttons.at(-1).right) / 2, footerCenter: footer.left + footer.width / 2,
        top: group.top, bottom: group.bottom, footerTop: footer.top, footerBottom: footer.bottom };
    });
    assert.ok(Math.abs(bounds.center - bounds.footerCenter) < 1, `${width}px 主题按钮应居中`);
    assert.ok(bounds.top >= bounds.footerTop && bounds.bottom <= bounds.footerBottom);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.screenshot({ path: path.join(artifacts, 'footer-mobile.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await opened();
  assert.equal(await page.locator('.site-navigation').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  await toggle.click();
  await closed();

  await page.goto(new URL('p/rin/', baseURL).href);
  const source = page.locator('[data-zoomable]').first();
  await source.click();
  await page.waitForFunction(() => document.querySelector('.image-dialog')?.dataset.state === 'open');
  const close = page.getByRole('button', { name: '关闭图片预览', exact: true });
  assert.equal(await close.locator('svg path').count(), 1);
  assert.equal(await close.textContent(), '');
  const size = await close.boundingBox();
  assert.ok(size.width >= 44 && size.height >= 44, '关闭图标需要足够的触控区域');
  await page.screenshot({ path: path.join(artifacts, 'preview-close.png') });
  await close.click();
  await page.waitForFunction(() => !document.querySelector('.image-dialog').open);
  assert.ok(await source.evaluate(el => el === document.activeElement));
  const noJS = await browser.newPage({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  await noJS.goto(baseURL);
  assert.ok(await noJS.locator('.site-nav').isVisible());
  assert.equal(await noJS.locator('.site-nav-toggle').isVisible(), false);
  await noJS.close();
  assert.deepEqual(errors, []);
  console.log(`移动控件检查通过：图标切换、popover 双向动画、快速切换、焦点与断点、footer 居中、SVG 关闭、减少动效及无 JS 回退。截图：${artifacts}`);
} finally {
  await browser.close();
}
