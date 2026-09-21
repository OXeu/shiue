import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const articleURL = new URL('p/ssg-blog-comment/', baseURL).href;
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-d2-viewport-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', error => errors.push(error.message));
const block = page.locator('[data-d2]').first();
const viewport = block.locator('[data-d2-output]');
const action = name => block.locator(`[data-d2-action="${name}"]`).click();
const near = (actual, expected, label, tolerance = .02) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} ≠ ${expected}`);
const camera = locator => locator.evaluate(element => {
  const matrix = new DOMMatrix(getComputedStyle(element.querySelector('[data-d2-active]')).transform);
  return { scale: matrix.a, x: matrix.e, y: matrix.f, width: element.clientWidth, height: element.clientHeight };
});
const fits = locator => locator.evaluate(element => {
  const frame = element.getBoundingClientRect();
  const svg = element.querySelector('[data-d2-active]').getBoundingClientRect();
  return svg.left >= frame.left && svg.top >= frame.top && svg.right <= frame.right + 1 && svg.bottom <= frame.bottom + 1;
});

try {
  await page.goto(articleURL);
  await block.scrollIntoViewIfNeeded();
  await viewport.locator('[data-d2-active]').waitFor();
  await block.scrollIntoViewIfNeeded();
  assert.ok(await fits(viewport), '首次显示应能看到整张图');
  const initial = await camera(viewport);
  await action('in');
  assert.ok((await camera(viewport)).scale > initial.scale);
  await action('out');
  near((await camera(viewport)).scale, initial.scale, '缩小恢复前一比例');
  await action('actual');
  near((await camera(viewport)).scale, 1, '原始大小');

  let box = await viewport.boundingBox();
  let previous = await camera(viewport);
  await page.mouse.move(box.x + 160, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 200, { steps: 6 });
  const dragged = await camera(viewport);
  near(dragged.x - previous.x, 100, '水平拖拽');
  near(dragged.y - previous.y, 60, '垂直拖拽');
  await page.mouse.move(box.x + box.width + 40, box.y + 200);
  await page.mouse.up();
  assert.equal(await viewport.evaluate(element => element.classList.contains('is-dragging')), false, '框外释放也应结束拖拽');
  previous = await camera(viewport);
  await page.mouse.move(box.x + 100, box.y + 100);
  assert.deepEqual(await camera(viewport), previous, '松开后移动鼠标不得继续拖图');

  await action('fit');
  await action('actual');
  box = await viewport.boundingBox();
  const border = await viewport.evaluate(element => ({ x: element.clientLeft, y: element.clientTop }));
  const anchor = {
    x: Math.round(box.x + 180 + border.x) - box.x - border.x,
    y: Math.round(box.y + 140 + border.y) - box.y - border.y,
  };
  previous = await camera(viewport);
  const pageScroll = await page.evaluate(() => scrollY);
  await page.mouse.move(box.x + anchor.x + border.x, box.y + anchor.y + border.y);
  await page.mouse.wheel(0, -90);
  await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector('[data-d2-active]')).transform).a > 1);
  let next = await camera(viewport);
  near((anchor.x - next.x) / next.scale, (anchor.x - previous.x) / previous.scale, '缩放水平锚点');
  near((anchor.y - next.y) / next.scale, (anchor.y - previous.y) / previous.scale, '缩放垂直锚点');
  near(await page.evaluate(() => scrollY), pageScroll, '图框内滚轮不移动页面');
  near(await page.evaluate(() => visualViewport.scale), 1, '缩放图表不缩放浏览器视口');
  previous = next;
  await page.mouse.wheel(0, 200);
  await page.waitForFunction(scale => new DOMMatrix(getComputedStyle(document.querySelector('[data-d2-active]')).transform).a < scale, previous.scale);
  assert.ok((await camera(viewport)).scale < previous.scale, '向下滚轮应缩小图表');
  near(await page.evaluate(() => scrollY), pageScroll, '缩小图表也不移动页面');

  const viewer = block.locator('[data-d2-viewer]');
  await action('fullscreen');
  await page.waitForFunction(() => document.querySelector('[data-d2-viewer]')?.classList.contains('is-fullscreen'));
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('d2-fullscreen-open')), true, '全屏预览应锁定页面滚动');
  assert.equal(await block.locator('[data-d2-action="close"]').isVisible(), true, '全屏预览应显示关闭按钮');
  const fullscreenBox = await viewer.boundingBox();
  near(fullscreenBox.x, 0, '全屏预览左边缘', 1);
  near(fullscreenBox.y, 0, '全屏预览上边缘', 1);
  near(fullscreenBox.width, 1280, '全屏预览宽度', 1);
  near(fullscreenBox.height, 900, '全屏预览高度', 1);
  const dock = await block.locator('[data-d2-controls]').evaluate(node => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { right: innerWidth - box.right, top: box.top, position: style.position, radius: style.borderRadius, blur: style.backdropFilter };
  });
  assert.equal(dock.position, 'fixed');
  assert.ok(dock.right <= 17 && dock.top <= 17, '全屏操作区应悬浮在右上角');
  assert.notEqual(dock.radius, '0px', '全屏操作区应为圆角矩形');
  assert.notEqual(dock.blur, 'none', '全屏操作区应启用毛玻璃模糊');
  await viewer.screenshot({ path: path.join(artifacts, 'fullscreen-dock.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-d2-viewer]')?.classList.contains('is-fullscreen'));
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('d2-fullscreen-open')), false);
  await action('fullscreen');
  await block.locator('[data-d2-action="close"]').click();
  assert.equal(await viewer.evaluate(node => node.classList.contains('is-fullscreen')), false, '右上角关闭按钮应退出全屏');

  await viewport.scrollIntoViewIfNeeded();
  await action('actual');
  box = await viewport.boundingBox();
  await page.mouse.dblclick(box.x + 180, box.y + 100);
  near((await camera(viewport)).scale, 2, '双击放大');
  await page.keyboard.down('Shift');
  await page.mouse.dblclick(box.x + 180, box.y + 100);
  await page.keyboard.up('Shift');
  near((await camera(viewport)).scale, 1, 'Shift 双击缩小');
  await viewport.focus();
  await page.keyboard.press('Equal');
  assert.ok((await camera(viewport)).scale > 1, '键盘放大');
  previous = await camera(viewport);
  await page.keyboard.press('ArrowRight');
  assert.ok((await camera(viewport)).x < previous.x, '方向键平移');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Equal');
  near((await camera(viewport)).scale, 4, '最大缩放比例');
  assert.ok(await block.locator('[data-d2-action="in"]').isDisabled());
  for (let i = 0; i < 45; i++) await page.keyboard.press('Minus');
  assert.ok(await block.locator('[data-d2-action="out"]').isDisabled());
  await page.keyboard.press('0');
  assert.ok(await fits(viewport), '0 适应窗口');
  await page.keyboard.press('1');
  near((await camera(viewport)).scale, 1, '1 原始大小');

  await action('in');
  previous = await camera(viewport);
  await page.locator('button[data-color-mode="dark"]').click();
  await page.waitForSelector('[data-d2-theme="dark"]');
  next = await camera(viewport);
  near(next.scale, previous.scale, '主题切换保留缩放');
  near(next.x, previous.x, '主题切换保留水平位置');
  near(next.y, previous.y, '主题切换保留垂直位置');
  await block.scrollIntoViewIfNeeded();
  await block.screenshot({ path: path.join(artifacts, 'desktop-dark.png') });

  const worldCenter = { x: (next.width / 2 - next.x) / next.scale, y: (next.height / 2 - next.y) / next.scale };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(expected => {
    const frame = document.querySelector('[data-d2-output]');
    const matrix = new DOMMatrix(getComputedStyle(frame.querySelector('[data-d2-active]')).transform);
    return Math.abs((frame.clientWidth / 2 - matrix.e) / matrix.a - expected.x) < .1;
  }, worldCenter);
  next = await camera(viewport);
  near((next.height / 2 - next.y) / next.scale, worldCenter.y, '改变宽度保留垂直中心', .1);
  await action('fit');
  assert.ok(await fits(viewport));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不得横向溢出');
  await block.scrollIntoViewIfNeeded();
  await block.screenshot({ path: path.join(artifacts, 'mobile-fit.png') });

  // 图表实例相互独立，检查缩放和复位不会修改同页其他图表。
  await page.route(articleURL, async route => {
    const response = await route.fetch();
    const $ = load(await response.text());
    const fixture = $('[data-d2]').first().clone();
    $('.article .prose').empty().append(fixture, fixture.clone());
    await route.fulfill({ response, body: $.html() });
  });
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(articleURL);
  await page.locator('[data-d2]').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('[data-d2-active]').length === 2);
  const second = page.locator('[data-d2-output]').last();
  const untouched = await camera(second);
  await action('in');
  await action('actual');
  assert.deepEqual(await camera(second), untouched, '缩放第一张图不能影响第二张');
  await action('fit');
  assert.deepEqual(await camera(second), untouched);

  // CDP 发送真实触屏输入，由浏览器产生 Pointer Events 和指针捕获。
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', error => errors.push(error.message));
  const touchViewport = mobile.locator('[data-d2-output]');
  await mobile.goto(articleURL);
  await mobile.locator('[data-d2]').scrollIntoViewIfNeeded();
  await touchViewport.locator('[data-d2-active]').waitFor();
  await mobile.locator('[data-d2-action="actual"]').click();
  await touchViewport.scrollIntoViewIfNeeded();
  box = await touchViewport.boundingBox();
  const session = await mobile.context().newCDPSession(mobile);
  const sendTouch = (type, touchPoints) => session.send('Input.dispatchTouchEvent', { type, touchPoints });
  const point = (id, x, y) => ({ id, x, y, radiusX: 2, radiusY: 2, force: 1 });
  const cx = box.x + box.width / 2;
  const cy = box.y + 130;
  const touchScroll = await mobile.evaluate(() => scrollY);
  await sendTouch('touchStart', [point(1, cx - 40, cy), point(2, cx + 40, cy)]);
  await sendTouch('touchMove', [point(1, cx - 70, cy), point(2, cx + 70, cy)]);
  await sendTouch('touchEnd', []);
  assert.ok((await camera(touchViewport)).scale > 1.5, '双指捏合应放大图表');
  near(await mobile.evaluate(() => visualViewport.scale), 1, '捏合不缩放整页');
  near(await mobile.evaluate(() => scrollY), touchScroll, '图框内手势不滚动整页');
  previous = await camera(touchViewport);
  await sendTouch('touchStart', [point(1, cx, cy)]);
  await sendTouch('touchMove', [point(1, cx + 50, cy + 45)]);
  await sendTouch('touchCancel', []);
  next = await camera(touchViewport);
  near(next.x - previous.x, 50, '单指水平拖拽', 1);
  near(next.y - previous.y, 45, '单指垂直拖拽', 1);
  assert.equal(await touchViewport.evaluate(element => element.classList.contains('is-dragging')), false, '取消触摸应清理拖拽状态');
  await mobile.locator('[data-d2-action="fullscreen"]').click();
  const mobileDock = await mobile.locator('[data-d2-controls]').boundingBox();
  assert.ok(mobileDock.x >= 0 && mobileDock.x + mobileDock.width <= 390, '手机全屏操作区不得溢出视口');
  await mobile.locator('[data-d2-action="close"]').click();
  await mobile.locator('[data-d2]').screenshot({ path: path.join(artifacts, 'touch-zoom.png') });
  await sendTouch('touchStart', [point(1, 4, 600)]);
  for (const y of [550, 500, 450, 400, 350]) await sendTouch('touchMove', [point(1, 4, y)]);
  await sendTouch('touchEnd', []);
  await mobile.waitForFunction(y => scrollY !== y, touchScroll);
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log(`D2 图表交互检查通过：滚轮指针锚点、缩放边界、拖拽及框外释放、全屏 Dock 与 Esc/X、键盘、原图/适应、主题/尺寸状态保留、多图隔离、触屏捏合/拖拽/取消、页面正常滚动。截图：${artifacts}`);
} finally {
  await browser.close();
}
