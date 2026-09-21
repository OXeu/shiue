import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-article-hero-'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.addInitScript(() => {
  window.__heroProbe = { frames: [], finished: false };
  window.addEventListener('pagereveal', event => {
    if (!event.viewTransition) return;
    event.viewTransition.ready.then(() => {
      window.__heroProbe.frames = document.getAnimations().filter(animation => animation.effect?.pseudoElement)
        .map(animation => ({ pseudo: animation.effect.pseudoElement, frames: animation.effect.getKeyframes() }));
    }, error => { window.__heroProbe.error = error.message; });
    event.viewTransition.finished.then(() => { window.__heroProbe.finished = true; });
  });
});
const page = await context.newPage();
const open = route => page.goto(new URL(route, baseURL).href, { waitUntil: 'load' });
const settle = async () => {
  await page.waitForFunction(() => !document.documentElement.dataset.articleTransition);
  assert.equal(await page.locator('[style*="view-transition-name"]').count(), 0, '快照名称必须在动画后清理');
};
const captured = async name => {
  await page.waitForFunction(name => window.__heroProbe.frames.some(frame => frame.pseudo === `::view-transition-group(${name})`), name);
  return page.evaluate(name => window.__heroProbe.frames.find(frame => frame.pseudo === `::view-transition-group(${name})`).frames, name);
};
const assertSingleCoverSnapshot = async direction => {
  const hidden = direction === 'open' ? 'old' : 'new';
  const visible = direction === 'open' ? 'new' : 'old';
  const styles = await page.evaluate(([hidden, visible]) => ({
    hidden: getComputedStyle(document.documentElement, `::view-transition-${hidden}(article-cover)`).display,
    visibleAnimation: getComputedStyle(document.documentElement, `::view-transition-${visible}(article-cover)`).animationName,
  }), [hidden, visible]);
  assert.equal(styles.hidden, 'none', 'Hero 过渡必须隐藏另一张图片快照');
  assert.equal(styles.visibleAnimation, 'none', 'Hero 的唯一图片快照不得执行透明度动画');
  assert.equal(await page.evaluate(() => window.__heroProbe.frames.some(frame =>
    frame.pseudo === '::view-transition-old(article-cover)' || frame.pseudo === '::view-transition-new(article-cover)')),
  false, 'Hero 图片不得交叉淡化');
};

try {
  // 捕获浏览器生成的真实关键帧，验证卡片和封面从原位置展开到正文。
  await open('');
  await page.waitForFunction(() => document.querySelector('.card-cover img').naturalWidth > 0);
  await page.waitForTimeout(400);
  const card = page.locator('.post-card').filter({ has: page.locator('.card-cover') }).first();
  const link = card.locator('.card-title a');
  const target = await link.getAttribute('href');
  const cardBox = await card.boundingBox();
  const coverBox = await card.locator('.card-cover').boundingBox();
  await link.click();
  const panel = await captured('article-panel');
  const cover = await captured('article-cover');
  assert.ok(Math.abs(parseFloat(panel[0].width) - cardBox.width) < 1);
  assert.ok(Math.abs(parseFloat(cover[0].width) - coverBox.width) < 1);
  assert.ok(parseFloat(panel.at(-1).width) > parseFloat(panel[0].width) * 2);
  assert.ok(parseFloat(cover.at(-1).width) > parseFloat(cover[0].width) * 2);
  assert.notEqual(cover[0].transform, cover.at(-1).transform);
  await assertSingleCoverSnapshot('open');
  await captured('article-title');
  await writeFile(path.join(artifacts, 'native-keyframes.json'), JSON.stringify(await page.evaluate(() => window.__heroProbe.frames), null, 2));
  // 固定在真实动画的中间时刻截图，然后恢复播放。
  await page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.pseudoElement).forEach(animation => {
    animation.pause();
    animation.currentTime = 220;
  }));
  await page.screenshot({ path: path.join(artifacts, 'expanding.png') });
  await page.evaluate(() => document.getAnimations().forEach(animation => animation.play()));
  await settle();
  await page.screenshot({ path: path.join(artifacts, 'article.png') });

  // 返回列表与再次前进，覆盖 BFCache 以及快照标记清理。
  await page.goBack();
  const reverse = await captured('article-panel');
  assert.ok(parseFloat(reverse[0].width) > parseFloat(reverse.at(-1).width));
  await assertSingleCoverSnapshot('close');
  await settle();
  await page.goForward();
  await captured('article-title');
  await settle();

  // 键盘从动态搜索结果打开文章。
  await open('search/?keyword=Rin');
  await page.waitForFunction(() => document.querySelector('.card-title a'));
  await page.locator('.card-title a').first().focus();
  await page.locator('.card-title a').first().press('Enter');
  await captured('article-panel');
  await settle();

  // 手机下展开后的实际几何尺寸应与正文一致。
  await page.setViewportSize({ width: 390, height: 844 });
  await open('');
  await page.locator('.card-title a').first().click();
  const mobile = await captured('article-panel');
  assert.ok(Math.abs(parseFloat(mobile.at(-1).width) - (await page.locator('.article-heading').boundingBox()).width) < 1);
  await settle();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  // 动态减少动效时取消正在运行的过渡；之后打开链接也不再生成 Hero。
  await open('');
  await page.locator('.card-title a').first().click();
  await captured('article-panel');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle();
  await open('');
  await page.locator('.card-title a').first().click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__heroProbe.frames.some(frame => frame.pseudo.includes('article-'))), false);
  await settle();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // 无封面的卡片也能展开，不依赖图片节点。
  await open('');
  await page.locator('.card-cover').first().evaluate(el => el.remove());
  await page.locator('.card-title a').first().click();
  await captured('article-panel');
  await settle();

  // 原生链接行为：新标签页、无过渡脚本、无 JS 均正常打开正文。
  await open('');
  await page.locator('.card-title a').first().evaluate(link => { link.target = '_blank'; });
  const popupPromise = context.waitForEvent('page');
  await page.locator('.card-title a').first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.ok(await popup.locator('[data-article]').isVisible());
  assert.equal(await page.locator('[data-article]').count(), 0);
  await popup.close();
  await page.route('**/article-transition.*.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await open('');
  await page.locator('.card-title a').first().click();
  assert.ok(await page.locator('[data-article]').isVisible());
  assert.equal(await page.locator('[style*="view-transition-name"]').count(), 0);
  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(new URL(target, baseURL).href);
  assert.ok(await noJS.locator('[data-article]').isVisible());
  await noJS.close();
  assert.deepEqual(errors, []);
  console.log(`文章 Hero 检查通过：原生几何关键帧、返回/前进、搜索键盘入口、手机、减少动效、无封面与原生导航回退。产物：${artifacts}`);
} finally {
  await browser.close();
}
