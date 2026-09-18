import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateComment } from '../server/comments/core.js';
import { issueProof, verifyProof } from '../server/comments/pow.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/';
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-comments-browser-'));
const browser = await chromium.launch({ headless: true });
const message = '<img src=x onerror="window.commentXSS=true">\n评论保持纯文本';
const powEnv = { COMMENTS_POW_SECRET: 'browser-test-only'.repeat(4) };
try {
  for (const mode of ['light', 'dark']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(mode => localStorage.setItem('xeu-color-mode', mode), mode);
    const page = await context.newPage();
    const errors = [];
    const submissions = [];
    const challenges = [];
    const workers = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    page.on('worker', worker => workers.push(worker.url()));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(baseURL).origin) return route.abort();
      if (url.pathname === '/api/comments-challenge') {
        const body = route.request().postDataJSON();
        challenges.push(body);
        return route.fulfill({ json: issueProof(validateComment(body), new URL(baseURL), powEnv, Date.now()) });
      }
      if (url.pathname === '/api/comments-submit') {
        const body = route.request().postDataJSON();
        verifyProof(body.proof, validateComment(body), new URL(baseURL), powEnv, Date.now());
        submissions.push(body);
        if (submissions.length === 1) return route.fulfill({ status: 503, json: { error: '服务暂时不可用，请重试。' } });
        await gate;
        return route.fulfill({ status: 202, json: { message: '评论已送交审核，通过并完成部署后会显示在这里。' } });
      }
      return route.continue();
    });
    try {
      await page.goto(new URL('p/ai-random-thoughts/', baseURL).href);
      assert.equal(submissions.length, 0, '阅读评论不能请求写入 API');
      assert.equal(challenges.length, 0, '阅读时不能获取挑战');
      assert.equal(workers.length, 0, '阅读时不能启动计算');
      assert.equal(await page.locator('script[src*="twikoo"]').count(), 0);
      const initialCount = await page.locator('.comment-list > li').count();
      const form = page.locator('[data-comment-form]');
      const popover = page.locator('#comment-editor');
      const compose = page.locator('[data-new-comment]');
      const close = page.locator('[data-close-comment]');
      assert.equal(await form.isHidden(), true, '阅读时不显示编辑面板');
      await compose.click();
      assert.equal(await compose.getAttribute('aria-expanded'), 'true');
      assert.equal(await popover.locator('.comment-help svg[viewBox="0 0 24 24"]').count(), 3, '三个说明使用 SVG 问号图标');
      await form.locator('[name="name"]').fill('测试读者');
      await form.locator('[name="message"]').fill(message);
      await form.locator('[name="consent"]').check();
      assert.equal(await form.locator('[name="email"]').getAttribute('required'), null);
      await form.locator('[name="email"]').fill('invalid-email');
      await form.locator('[type="submit"]').click();
      assert.equal(challenges.length, 0, '邮箱格式无效时不能发起验证');
      await form.locator('[name="email"]').fill('browser-reader@example.org');
      const replies = page.locator('.comment-replies [data-reply-id]');
      if (process.env.SHIUE_TEST_REQUIRE_REPLIES === '1') assert.ok(await replies.count() >= 6, '请使用 check-build 生成的嵌套留言产物');
      let parentId;
      if (await replies.count()) {
        const target = replies.last();
        parentId = await target.getAttribute('data-reply-id');
        await close.click();
        await target.click();
        assert.equal(await form.locator('[name="parentId"]').inputValue(), parentId);
        assert.equal(await form.locator('[data-reply-target]').textContent(), await target.getAttribute('data-reply-name'));
        assert.equal(await form.locator('textarea').evaluate(node => node === document.activeElement), true);
        assert.equal(await form.locator('textarea').inputValue(), '', '不同回复对象不能共用草稿');
        await form.locator('[name="name"]').fill('回复读者');
        await form.locator('[name="message"]').fill('回复草稿');
        await page.keyboard.press('Escape');
        assert.equal(await popover.isHidden(), true);
        assert.equal(await target.evaluate(node => node === document.activeElement), true);
        await compose.click();
        assert.equal(await form.locator('[name="parentId"]').inputValue(), '');
        assert.equal(await form.locator('textarea').inputValue(), message, '切回独立留言应恢复其草稿');
        assert.equal(await form.locator('[data-reply-context]').isHidden(), true);
        await close.click();
        await target.click();
        assert.equal(await form.locator('textarea').inputValue(), '回复草稿');
        await form.locator('[name="message"]').fill(message);
        await form.locator('[name="email"]').fill('browser-reader@example.org');
        await form.locator('[name="consent"]').check();
      }
      const bounds = await popover.boundingBox();
      const anchor = await (parentId ? replies.last() : compose).boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900, 'popover 不应超出视口');
      assert.ok(Math.min(Math.abs(bounds.y - anchor.y - anchor.height), Math.abs(bounds.y + bounds.height - anchor.y)) <= 9, 'popover 应紧邻触发按钮');
      await page.screenshot({ path: path.join(artifacts, `editor-${mode}-${width}.png`) });
      const submit = form.locator('[type="submit"]');
      await submit.click();
      await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('不可用'));
      assert.equal(await form.locator('textarea').inputValue(), message, '失败后不能丢失草稿');
      assert.equal(await form.locator('[name="email"]').inputValue(), 'browser-reader@example.org');
      assert.equal(await form.locator('[name="parentId"]').inputValue(), parentId || '', '失败后不能丢失回复对象');
      await page.reload();
      assert.equal(await form.isHidden(), true);
      await (parentId ? page.locator(`[data-reply-id="${parentId}"]`) : compose).click();
      assert.equal(await form.locator('textarea').inputValue(), message, '刷新后应恢复本地草稿及重试编号');
      await submit.click();
      await page.waitForFunction(() => document.querySelector('[data-comment-form] fieldset').disabled);
      await submit.evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => document.querySelector('[data-comment-feedback]').dataset.state === 'sending');
      assert.equal(await form.locator('fieldset').isHidden(), true, '状态面板覆盖编辑内容');
      assert.equal(await form.locator('fieldset').evaluate(node => node.inert), true);
      assert.equal(await form.locator('[data-cancel-proof]').isHidden(), true, '发信阶段不可取消');
      const panelBounds = await form.locator('[data-comment-feedback]').boundingBox();
      const popoverBounds = await popover.boundingBox();
      assert.ok(Math.abs(panelBounds.width - popoverBounds.width) <= 2 && Math.abs(panelBounds.height - popoverBounds.height) <= 2, '状态面板覆盖整个 popover');
      await page.screenshot({ path: path.join(artifacts, `sending-${mode}-${width}.png`) });
      release();
      await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('评论已送交审核'));
      assert.equal(await form.locator('[data-comment-feedback]').getAttribute('data-state'), 'success');
      assert.equal(await form.locator('[data-comment-done]').isVisible(), true);
      assert.equal(await form.locator('[data-comment-done]').evaluate(node => node === document.activeElement), true);
      await page.screenshot({ path: path.join(artifacts, `success-${mode}-${width}.png`) });
      assert.equal(submissions.length, 2, '正在发送时不能重复提交');
      assert.equal(challenges.length, 2, '重试应取得新的短期挑战');
      assert.equal(workers.length, 2);
      assert.notEqual(submissions[0].proof.token, submissions[1].proof.token);
      assert.equal(submissions[0].id, submissions[1].id, '重试必须沿用幂等编号');
      assert.equal(submissions[0].createdAt, submissions[1].createdAt);
      assert.equal(submissions[1].consent, true);
      assert.equal(submissions[1].email, 'browser-reader@example.org');
      assert.equal(submissions[0].parentId, parentId);
      assert.equal(submissions[1].parentId, parentId, '嵌套回复和重试必须保留直接父留言');
      assert.equal(submissions[1].path, new URL('p/ai-random-thoughts/', baseURL).pathname);
      assert.equal(await form.locator('textarea').inputValue(), '');
      assert.equal(await form.locator('[name="email"]').inputValue(), '');
      assert.equal(await form.locator('[name="parentId"]').inputValue(), parentId || '');
      assert.equal(await page.evaluate(({ articlePath, parentId }) => localStorage.getItem(`xeu-comment-draft:v1:${encodeURIComponent(articlePath)}:${parentId || 'root'}`), { articlePath: new URL(page.url()).pathname, parentId }), null, '成功后清除当前草稿');
      assert.equal(await page.locator('.comment-list > li').count(), initialCount, '待审评论不应直接显示');
      assert.equal(await page.evaluate(() => window.commentXSS), undefined);
      assert.equal(await page.locator('[data-comments] img, [data-comments] script').count(), 0, '留言和回复昵称不能变成 HTML');
      if (parentId) {
        // 回复成功后，继续发顶层留言，不应沿用上次的父编号。
        await form.locator('[data-comment-done]').click();
        assert.equal(await popover.isHidden(), true);
        await page.locator(`[data-reply-id="${parentId}"]`).click();
        assert.equal(await form.locator('fieldset').isVisible(), true, '成功后重开恢复可编辑面板');
        assert.equal(await form.locator('textarea').inputValue(), '');
        await close.click();
        await compose.click();
        assert.equal(await form.locator('textarea').inputValue(), message, '回复成功不能清除独立留言的草稿');
        await form.locator('[name="name"]').fill('顶层读者');
        await form.locator('[name="message"]').fill('新的独立留言');
        await form.locator('[name="email"]').fill('');
        await form.locator('[name="consent"]').check();
        await submit.click();
        await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('评论已送交审核'));
        assert.equal(submissions.length, 3);
        assert.equal(submissions[2].parentId, undefined);
        assert.equal(submissions[2].email, undefined, '不填写邮箱也可提交');
        assert.notEqual(submissions[2].id, submissions[1].id);
      }
      await close.click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('[data-comments]').screenshot({ path: path.join(artifacts, `comments-${mode}-${width}.png`) });
      assert.deepEqual(errors, []);
    } finally { release(); await context.close(); }
  }

  for (const scenario of ['native', 'fallback', 'storage-unavailable']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addInitScript(scenario => {
      if (scenario === 'fallback') HTMLElement.prototype.showPopover = undefined;
      if (scenario === 'storage-unavailable') {
        for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => { throw new Error('Storage unavailable'); };
      }
    }, scenario);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(new URL('p/ai-random-thoughts/', baseURL).href);
      const compose = page.locator('[data-new-comment]');
      const form = page.locator('[data-comment-form]');
      const popover = page.locator('#comment-editor');
      const close = page.locator('[data-close-comment]');
      const replies = page.locator('[data-reply-id]');
      await compose.click();
      await form.locator('textarea').fill('独立留言草稿');
      await page.mouse.click(2, 2);
      assert.equal(await popover.isHidden(), true, '点击外部关闭 popover');
      await compose.click();
      assert.equal(await form.locator('textarea').inputValue(), '独立留言草稿');
      await close.click();
      if (await replies.count() >= 2) {
        await replies.nth(0).click();
        await form.locator('textarea').fill('第一条回复草稿');
        await close.click();
        await replies.nth(1).click();
        assert.equal(await form.locator('textarea').inputValue(), '');
        await form.locator('textarea').fill('第二条回复草稿');
        await page.keyboard.press('Escape');
        await replies.nth(0).click();
        assert.equal(await form.locator('textarea').inputValue(), '第一条回复草稿', '不同回复之间隔离草稿');
        const style = await replies.nth(0).evaluate(node => ({ border: getComputedStyle(node).borderWidth, row: node.parentElement.className }));
        assert.equal(style.border, '0px');
        assert.equal(style.row, 'comment-byline');
        await close.click();
      }
      await compose.click();
      await page.setViewportSize({ width: 320, height: 480 });
      await page.waitForTimeout(100);
      const bounds = await popover.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= 480, '缩小视口后面板仍可访问');
      await page.screenshot({ path: path.join(artifacts, `editor-${scenario}-320.png`) });
      if (scenario === 'storage-unavailable') {
        assert.match(await page.locator('[data-draft-note]').textContent(), /未允许保存草稿/);
      } else {
        await page.goto(new URL('p/rin/', baseURL).href);
        await compose.click();
        assert.equal(await form.locator('textarea').inputValue(), '', '不同文章之间隔离草稿');
        await page.goto(new URL('p/ai-random-thoughts/', baseURL).href);
        await compose.click();
        assert.equal(await form.locator('textarea').inputValue(), '独立留言草稿', '离开文章后返回恢复草稿');
        await compose.click();
        assert.equal(await popover.isHidden(), true, '再次点击同一按钮关闭');
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  for (const timezoneId of ['Asia/Shanghai', 'America/New_York']) {
    const context = await browser.newContext({ timezoneId, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const now = Date.parse('2026-09-18T20:00:00Z');
    await page.clock.install({ time: now });
    await page.route('**/p/ai-random-thoughts/', async route => {
      const response = await route.fetch();
      const elapsed = [0, 180_000, 172_800_000, 259_200_000, 345_600_000, -60_000];
      let index = 0;
      const body = (await response.text()).replace(/<time\b[^>]*data-comment-time[^>]*>[\s\S]*?<\/time>/g, () => {
        const date = new Date(now - elapsed[index++ % elapsed.length]).toISOString();
        return `<time data-comment-time datetime="${date}">${date}</time>`;
      });
      return route.fulfill({ response, body });
    });
    try {
      await page.goto(new URL('p/ai-random-thoughts/', baseURL).href);
      const times = page.locator('[data-comment-time]');
      if (await times.count() < 6 && process.env.SHIUE_TEST_REQUIRE_REPLIES !== '1') continue;
      assert.equal(await times.nth(0).textContent(), '刚刚');
      assert.equal(await times.nth(1).textContent(), '3 分钟前');
      assert.equal(await times.nth(2).textContent(), '2 天前');
      await times.nth(1).click();
      const absolute = timezoneId === 'Asia/Shanghai' ? '2026-09-19 03:57' : '2026-09-18 15:57';
      assert.equal(await times.nth(1).textContent(), absolute, '浏览器时区决定绝对时间');
      await times.nth(1).press('Enter');
      assert.equal(await times.nth(1).textContent(), '3 分钟前');
      await times.nth(1).press('Space');
      assert.equal(await times.nth(1).textContent(), absolute);
      await times.nth(1).click();
      assert.equal(await times.nth(1).textContent(), '3 分钟前');
      for (const index of [3, 4, 5]) {
        const before = await times.nth(index).textContent();
        await times.nth(index).click();
        assert.equal(await times.nth(index).textContent(), before, '三天外及未来时间不可切换');
        assert.equal(await times.nth(index).getAttribute('role'), null);
      }
      await page.clock.fastForward(259_200_000);
      assert.equal(await times.nth(0).getAttribute('role'), null, '页面停留满三天后不再切换');
      assert.match(await times.nth(0).textContent(), /^2026-09-/);
    } finally { await context.close(); }
  }

  // Exercise the actual emitted worker at the default and optional odd-nibble difficulty,
  // then inject bounded failure cases only for cancellation/timeout scenarios.
  const proofPage = await browser.newPage();
  try {
    await proofPage.goto(new URL('p/ai-random-thoughts/', baseURL).href);
    const workerURL = await proofPage.locator('[data-comment-form]').getAttribute('data-pow-worker');
    const sample = { id: 'ae251682-6cc0-40df-bf31-6d48c12a985c', path: '/p/example/', name: '验证', message: '测试', createdAt: new Date().toISOString() };
    for (const difficulty of [undefined, undefined, undefined, undefined, undefined, '5']) {
      const benchmarkEnv = { ...powEnv, ...(difficulty ? { COMMENTS_POW_DIFFICULTY: difficulty } : {}) };
      const task = issueProof(sample, new URL(baseURL), benchmarkEnv, Date.now());
      const result = await proofPage.evaluate(({ workerURL, task }) => new Promise((resolve, reject) => {
        const worker = new Worker(workerURL);
        const start = performance.now();
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timed out')); }, 95000);
        worker.onmessage = ({ data }) => {
          if (data.error || data.nonce !== undefined) {
            clearTimeout(timer); worker.terminate();
            data.error ? reject(new Error('worker failed')) : resolve({ nonce: data.nonce, elapsed: performance.now() - start });
          }
        };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('worker load failed')); };
        worker.postMessage(task);
      }), { workerURL, task });
      verifyProof({ token: task.token, nonce: result.nonce }, sample, new URL(baseURL), benchmarkEnv, Date.now());
      console.log(`真实 Worker 难度 ${task.difficulty}：${result.elapsed.toFixed(0)} ms（本机样本，不代表移动设备性能）`);
    }
  } finally { await proofPage.close(); }

  for (const scenario of ['cancel', 'pagehide', 'timeout', 'worker-error', 'challenge-unavailable', 'expired-proof', 'unsupported']) {
    const context = await browser.newContext();
    await context.addInitScript(scenario => {
      window.powTerminations = 0;
      const Original = window.Worker;
      window.Worker = scenario === 'unsupported' ? undefined : class extends Original {
        terminate() { window.powTerminations++; super.terminate(); }
      };
      if (scenario === 'timeout') {
        const original = window.setTimeout;
        window.setTimeout = (fn, delay, ...args) => original(fn, delay === 90000 ? 50 : delay, ...args);
      }
    }, scenario);
    const page = await context.newPage();
    if (scenario === 'cancel') await page.setViewportSize({ width: 320, height: 360 });
    let submits = 0;
    let challenges = 0;
    await context.route('**/api/comments-challenge', route => {
      challenges++;
      if (scenario === 'challenge-unavailable') return route.fulfill({ status: 503, json: { error: '评论服务暂时不可用，请稍后重试。' } });
      return route.fulfill({ json: issueProof(validateComment(route.request().postDataJSON()), new URL(baseURL), powEnv, Date.now()) });
    });
    await context.route('**/api/comments-submit', route => {
      submits++;
      return route.fulfill({ status: 410, json: { error: '工作量证明已过期，请重新提交。' } });
    });
    if (['cancel', 'pagehide', 'timeout', 'worker-error'].includes(scenario)) {
      await context.route('**/js/comment-pow-worker.*.js', route => route.fulfill({ contentType: 'text/javascript', body: scenario === 'worker-error' ? 'self.onmessage=()=>self.postMessage({error:true})' : 'self.onmessage=()=>self.postMessage({elapsed:1})' }));
    }
    try {
      await page.goto(new URL('p/ai-random-thoughts/', baseURL).href);
      const form = page.locator('[data-comment-form]');
      const reply = page.locator('[data-reply-id]').first();
      const parentId = await reply.count() ? await reply.getAttribute('data-reply-id') : '';
      if (parentId) await reply.click();
      else await page.locator('[data-new-comment]').click();
      await form.locator('[name="name"]').fill('草稿');
      await form.locator('[name="message"]').fill(message);
      await form.locator('[name="consent"]').check();
      await form.locator('[type="submit"]').click();
      if (scenario === 'cancel' || scenario === 'pagehide') {
        await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('已用'));
        assert.equal(await form.locator('[data-comment-feedback]').getAttribute('data-state'), 'verifying');
        assert.equal(await form.locator('fieldset').isHidden(), true);
        assert.equal(await form.locator('[data-cancel-proof]').isVisible(), true);
        await page.screenshot({ path: path.join(artifacts, `verifying-${scenario}.png`) });
        await page.locator('[data-close-comment]').click();
        await (parentId ? reply : page.locator('[data-new-comment]')).click();
        assert.equal(await form.locator('[name="message"]').inputValue(), message, '验证中关闭和重开保留当前草稿');
        if (scenario === 'cancel') await form.locator('[data-cancel-proof]').click();
        else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      }
      const expected = { cancel: '已取消', pagehide: '已取消', timeout: '未能完成', 'worker-error': '未能完成', 'challenge-unavailable': '暂时不可用', 'expired-proof': '已过期', unsupported: '不支持' }[scenario];
      await page.waitForFunction(expected => document.querySelector('.comment-status').textContent.includes(expected), expected);
      assert.equal(await form.locator('[name="message"]').inputValue(), message);
      assert.equal(await form.locator('fieldset').isVisible(), true, '取消或失败后恢复编辑及草稿');
      assert.equal(await form.locator('fieldset').evaluate(node => node.inert), false);
      assert.equal(await form.locator('[name="parentId"]').inputValue(), parentId, '取消验证或故障后保留回复对象');
      assert.equal(await form.locator('[type="submit"]').isEnabled(), true);
      assert.equal(await form.locator('[data-cancel-proof]').isHidden(), true);
      assert.equal(submits, scenario === 'expired-proof' ? 1 : 0);
      assert.equal(challenges, scenario === 'unsupported' ? 0 : 1);
      if (['cancel', 'pagehide', 'timeout', 'worker-error', 'expired-proof'].includes(scenario)) assert.equal(await page.evaluate(() => window.powTerminations), 1);
      if (scenario === 'cancel') assert.equal(await form.locator('[type="submit"]').evaluate(el => el === document.activeElement), true);
    } finally { await context.close(); }
  }

  const page = await browser.newPage();
  const actions = [];
  await page.route('**/api/comments-approve', route => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    assert.equal(body.token, 'test-approval-token');
    if (body.action === 'preview') return route.fulfill({ json: { comment: { name: '<script>name</script>', message, parentId: 'e2ae8335-89b2-4f10-97db-cdb4603d23f4', createdAt: '2026-09-17T20:00:00.000Z' }, title: '审核测试', url: new URL('p/ai-random-thoughts/', baseURL).href } });
    if (actions.filter(action => action === 'approve').length === 1) return route.fulfill({ status: 502, json: { error: '任务未被接受，请重试。' } });
    if (body.action === 'approve') return route.fulfill({ status: 202, json: { message: '发布任务已提交，部分通知邮件未能发送。', notificationToken: 'test-notification-ticket', actionsURL: 'https://github.com/OXeu/shiue/actions/workflows/publish-comment.yml' } });
    assert.equal(body.action, 'notify');
    assert.equal(body.notificationToken, 'test-notification-ticket');
    if (actions.filter(action => action === 'notify').length === 1) return route.fulfill({ status: 503, json: { error: '通知发送暂时不可用，请重试。' } });
    return route.fulfill({ status: 202, json: { message: '通知邮件已交由邮件服务发送。', actionsURL: 'https://github.com/OXeu/shiue/actions/workflows/publish-comment.yml' } });
  });
  await page.goto(new URL('comment-review/#token=test-approval-token', baseURL).href);
  const approve = page.locator('[data-approve-comment]');
  await approve.waitFor({ state: 'visible' });
  assert.deepEqual(actions, ['preview'], '打开邮件链接不能触发发布');
  assert.equal(new URL(page.url()).hash, '', '审批凭据应立即从地址栏移除');
  assert.equal(await page.locator('[data-review-message]').textContent(), message);
  assert.equal(await page.locator('[data-review-parent]').isVisible(), true);
  assert.equal(await page.locator('[data-review-parent-link]').getAttribute('href'), new URL('p/ai-random-thoughts/#comment-e2ae8335-89b2-4f10-97db-cdb4603d23f4', baseURL).href);
  assert.equal(await page.locator('[data-review-content] img, [data-review-content] script').count(), 0);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('未被接受'));
  assert.equal(await approve.isEnabled(), true);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('[data-approve-comment]').textContent === '重试发送通知');
  assert.deepEqual(actions, ['preview', 'approve', 'approve']);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('通知发送暂时不可用'));
  assert.equal(await approve.isEnabled(), true);
  await approve.click();
  await approve.waitFor({ state: 'hidden' });
  assert.deepEqual(actions, ['preview', 'approve', 'approve', 'notify', 'notify'], '通知失败后仅重试邮件，不重新审批发布');
  assert.equal(await page.locator('[data-workflow-link]').isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'review.png') });
  await page.close();

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(new URL('p/ai-random-thoughts/', baseURL).href);
  assert.equal(await noJS.locator('[data-comments]').isVisible(), true, '无脚本仍能阅读静态评论');
  assert.equal(await noJS.locator('[data-comment-form] [type="submit"]').isDisabled(), true);
  assert.equal(await noJS.locator('[data-comment-form]').isHidden(), true);
  assert.equal(await noJS.locator('[data-new-comment]').isHidden(), true);
  for (const button of await noJS.locator('[data-reply-id]').all()) assert.equal(await button.isHidden(), true);
  if (process.env.SHIUE_TEST_REQUIRE_REPLIES === '1') assert.ok(await noJS.locator('.comment-replies .comment-message').count() >= 6, '无 JS 时多层回复仍可阅读');
  await noJS.close();
  console.log(`评论浏览器检查通过：锚定 popover、覆盖式验证/提交/成功状态、关闭/刷新恢复草稿、文章与回复草稿隔离、存储/Popover 降级、时区与相对时间切换、选填邮箱、多层回复、真实 PoW、取消/超时/故障、幂等重试、浅色/深色、桌面/手机、邮件审批与通知重试、无 JS 展示。截图：${artifacts}`);
} finally { await browser.close(); }
