import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-image-delivery-'));
const browser = await chromium.launch({ headless: true });
const measurements = [];

try {
  // 独立上下文避免缓存的大图影响 srcset 选择。
  for (const [width, density] of [
    [1174, 2], [390, 2], [1440, 1], [1440, 2],
    // 原网格断点附近也始终只请求小图。
    [608, 1], [620, 1], [628, 1], [892, 1], [912, 1], [1196, 1],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 823 }, deviceScaleFactor: density });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const requested = [];
    cdp.on('Network.requestWillBeSent', ({ type, request }) => {
      if (type === 'Image') requested.push({ url: request.url, priority: request.initialPriority });
    });
    await page.goto(baseURL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-masonry]').classList.contains('is-masonry'));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('.card-cover img')]
        .filter(img => img.getBoundingClientRect().top < innerHeight).map(img => img.decode()));
    });
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.effect?.target?.closest?.('[data-masonry]')));
    const covers = await page.locator('.card-cover img').evaluateAll(images => images.map(img => ({
      src: img.currentSrc, srcset: img.srcset, sizes: img.sizes, loading: img.loading, priority: img.fetchPriority,
      width: img.getBoundingClientRect().width, top: img.getBoundingClientRect().top,
    })));
    const first = covers[0];
    assert.equal(first.loading, 'eager');
    assert.equal(first.priority, 'high');
    assert.equal(first.srcset, '', '列表不应提供正文中图候选');
    assert.equal(first.sizes, '');
    assert.ok(covers.slice(1).every(img => img.loading === 'lazy' && img.priority !== 'high'));
    assert.ok(covers.slice(1).every(img => !img.srcset && !img.sizes));
    const pixels = Number(first.src.match(/-(\d+)\.webp$/)?.[1]);
    assert.equal(pixels, 640, '列表必须固定加载 640px 小图');
    const firstPath = new URL(first.src).pathname;
    const firstRequests = requested.filter(request => new URL(request.url).pathname === firstPath);
    assert.equal(firstRequests.length, 1, '首图不应重复下载 fallback 和 srcset 图片');
    assert.equal(firstRequests[0].priority, 'High', '首图请求应从一开始就是高优先级');
    assert.ok(requested.every(request => new URL(request.url).pathname.includes('/xeu-images/')), '列表不得请求原图');
    assert.deepEqual(errors, []);
    const resources = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(item => item.name.includes('/xeu-images/')).map(item => ({ url: item.name, bytes: item.encodedBodySize })));
    const bytes = resources.reduce((sum, item) => sum + item.bytes, 0);
    measurements.push({ width, density, covers, resources, bytes });
    await page.screenshot({ path: path.join(artifacts, `home-${width}-${density}.png`) });
    console.log(`${width}px / ${density}x：首图 ${pixels}px，高优先级且无重复请求；当前图片 ${(bytes / 1024).toFixed(1)} KiB`);
    await page.close();
  }
  for (const route of ['', 'tags/ubuntu/', 'tags/binder/']) {
    const noJS = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1440, height: 823 } });
    await noJS.goto(new URL(route, baseURL).href);
    const img = await noJS.locator('.card-cover img').first().evaluate(img => ({
      loaded: img.complete && img.naturalWidth > 0, loading: img.loading, width: img.getBoundingClientRect().width,
      selected: Number(img.currentSrc.match(/-(\d+)\.webp$/)?.[1]),
    }));
    assert.ok(img.loaded);
    assert.equal(img.loading, 'eager');
    assert.equal(img.selected, 640, '无 JS 列表也应固定使用小图');
    await noJS.close();
  }
  await writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(`图片加载检查通过，测量与截图：${artifacts}`);
} finally {
  await browser.close();
}
