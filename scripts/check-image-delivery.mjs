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
  for (const [width, density, maxWidth] of [
    [1174, 2, 768], [390, 2, 768], [1440, 1, 320], [1440, 2, 640],
    // 原网格断点附近，稳定滚动条会减少实际可用列数。
    [608, 1, 640], [620, 1, 640], [628, 1, 320],
    [892, 1, 480], [906, 1, 480], [912, 1, 320],
    [1176, 1, 480], [1190, 1, 480], [1196, 1, 320],
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
    assert.ok(!first.sizes.startsWith('auto'), '立即加载不能使用 sizes=auto');
    assert.match(first.srcset, /480w/);
    assert.match(first.srcset, /768w/);
    assert.ok(covers.slice(1).every(img => img.loading === 'lazy' && img.priority !== 'high'));
    assert.ok(covers.slice(1).every(img => img.sizes.startsWith('auto, ')));
    const pixels = Number(first.src.match(/-(\d+)\.webp$/)?.[1]);
    assert.ok(pixels >= first.width * density, '首图不能因缩小尺寸而低于显示像素需求');
    assert.ok(pixels <= maxWidth, `${width}px / ${density}x 选择了过大的缩略图：${first.src}`);
    const firstRequests = requested.filter(request => first.srcset.includes(new URL(request.url).pathname));
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
      largest: Math.max(...img.srcset.split(',').map(candidate => parseInt(candidate.trim().split(/\s+/)[1], 10))),
    }));
    assert.ok(img.loaded);
    assert.equal(img.loading, 'eager');
    assert.ok(img.selected >= Math.min(img.width, img.largest), '少量卡片的无 JS 网格不能按四列选取过小图片');
    await noJS.close();
  }
  await writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(`图片加载检查通过，测量与截图：${artifacts}`);
} finally {
  await browser.close();
}
