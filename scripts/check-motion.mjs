import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-motion-'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const open = route => page.goto(new URL(route, baseURL).href, { waitUntil: 'load' });
const closed = () => page.waitForFunction(() => !document.querySelector('.image-dialog')?.open);
const opened = () => page.waitForFunction(() => document.querySelector('.image-dialog')?.dataset.state === 'open');
const sample = async () => page.evaluate(async () => {
  const intervals = [];
  let previous = performance.now();
  const end = previous + 450;
  await new Promise(resolve => {
    function tick(now) {
      intervals.push(now - previous);
      previous = now;
      if (now < end) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  const sorted = intervals.slice(1).sort((a, b) => a - b);
  return { samples: sorted.length, p95Milliseconds: sorted[Math.floor(sorted.length * .95)], over33ms: sorted.filter(value => value > 33.4).length };
});

try {
  await open('p/rin/');
  await page.waitForFunction(() => document.querySelector('[data-zoomable]').complete && document.querySelector('[data-zoomable]').naturalWidth > 0);
  const source = page.locator('[data-zoomable]').first();
  const sourceURL = await source.getAttribute('data-original');
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route(new URL(sourceURL, baseURL).href, async route => { await delayed; await route.continue().catch(() => {}); });
  const before = await source.boundingBox();
  await source.click();
  assert.equal(await page.locator('.image-dialog').getAttribute('data-state'), 'opening');
  await page.waitForFunction(() => document.querySelector('.preview-thumbnail').complete && document.querySelector('.preview-thumbnail').naturalWidth > 0);
  assert.equal(await page.locator('.preview-thumbnail').evaluate(img => img.currentSrc), await source.evaluate(img => img.currentSrc));
  assert.equal(await page.locator('.image-dialog').evaluate(dialog => dialog.classList.contains('has-original')), false);
  const keyframes = await page.locator('.image-dialog-stage').evaluate(stage => stage.getAnimations()[0].effect.getKeyframes());
  assert.match(keyframes[0].transform, /scale\(/, '预览应从正文图片缩放展开');
  assert.ok(keyframes.every(frame => !('width' in frame) && !('height' in frame) && !('top' in frame) && !('left' in frame)), 'Hero 不应逐帧改变布局属性');
  const timing = await sample();
  await opened();
  await page.screenshot({ path: path.join(artifacts, 'preview-thumbnail.png') });
  release();
  await page.waitForFunction(() => document.querySelector('.image-dialog').classList.contains('has-original'));
  await page.waitForTimeout(220);
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => scrollY), scrollBefore, '预览时背景不应滚动');
  await page.keyboard.press('Escape');
  await closed();
  const after = await source.boundingBox();
  assert.ok(Math.abs(before.x - after.x) < 1 && Math.abs(before.width - after.width) < 1, '开合不应造成正文横向跳动');
  assert.equal(await source.evaluate(img => img === document.activeElement), true, '关闭后应恢复键盘焦点');
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');

  // 反向打断打开动画、连续开关，以及窗口尺寸变化。
  for (let attempt = 0; attempt < 3; attempt++) {
    await source.press('Enter');
    await page.keyboard.press('Escape');
    await closed();
    assert.equal(await source.evaluate(img => getComputedStyle(img).visibility), 'visible');
  }
  await source.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await opened();
  const preview = await page.locator('.image-dialog-stage').boundingBox();
  assert.ok(preview.x >= 0 && preview.y >= 0 && preview.x + preview.width <= 391 && preview.y + preview.height <= 844, '手机预览必须完整显示');
  await page.locator('.image-dialog-close').click();
  await closed();
  await page.setViewportSize({ width: 1440, height: 900 });
  await source.click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await opened();
  assert.equal(await page.locator('.image-dialog-stage').evaluate(stage => stage.getAnimations().length), 0);
  await page.locator('.image-dialog-close').click();
  await closed();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.unroute(new URL(sourceURL, baseURL).href);
  await page.route(new URL(sourceURL, baseURL).href, route => route.abort());
  await source.click();
  await page.waitForFunction(() => document.querySelector('.image-dialog-status').textContent.includes('暂时无法加载'));
  assert.ok(await page.locator('.preview-thumbnail').isVisible());
  await page.keyboard.press('Escape');
  await closed();

  const reduced = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  await reduced.goto(new URL('p/rin/', baseURL).href, { waitUntil: 'load' });
  await reduced.locator('[data-zoomable]').first().click();
  assert.equal(await reduced.locator('.image-dialog').getAttribute('data-state'), 'open');
  assert.equal(await reduced.locator('.image-dialog-stage').evaluate(stage => stage.getAnimations().length), 0);
  await reduced.keyboard.press('Escape');
  await reduced.waitForFunction(() => !document.querySelector('dialog[open]'));
  await reduced.close();

  const fallback = await browser.newPage();
  await fallback.addInitScript(() => { Element.prototype.animate = undefined; });
  await fallback.goto(new URL('p/rin/', baseURL).href, { waitUntil: 'load' });
  await fallback.locator('[data-zoomable]').first().click();
  await fallback.waitForFunction(() => document.querySelector('.image-dialog').dataset.state === 'open');
  await fallback.keyboard.press('Escape');
  await fallback.waitForFunction(() => !document.querySelector('dialog[open]'));
  await fallback.close();

  await open('');
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: '归档', exact: true }).click();
  await page.waitForURL('**/archives/');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.article-list'));
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
  assert.ok(await page.locator('.post-card').first().isVisible());
  assert.equal(await page.locator('.post-card').first().evaluate(card => getComputedStyle(card).opacity), '1');
  assert.equal(await page.locator('[style*="will-change"]').count(), 0, '动画结束后不应保留图层提示');
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'timing.json'), JSON.stringify(timing, null, 2));
  console.log(`动效检查通过：Hero 开合、原图异步切换、快速打断、焦点与滚动恢复、窗口变化、减少动态效果及 API 降级。帧采样：${JSON.stringify(timing)}；产物：${artifacts}`);
} finally {
  await browser.close();
}
