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
const powEnv = { COMMENTS_POW_SECRET: 'browser-test-only'.repeat(4), COMMENTS_POW_DIFFICULTY: '4' };
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
        await target.click();
        assert.equal(await form.locator('[name="parentId"]').inputValue(), parentId);
        assert.equal(await form.locator('[data-reply-target]').textContent(), await target.getAttribute('data-reply-name'));
        assert.equal(await form.locator('textarea').evaluate(node => node === document.activeElement), true);
        await form.locator('[data-cancel-reply]').click();
        assert.equal(await form.locator('[name="parentId"]').inputValue(), '');
        assert.equal(await form.locator('textarea').inputValue(), message, '取消回复不应丢弃草稿');
        assert.equal(await form.locator('[data-reply-context]').isHidden(), true);
        await target.click();
      }
      const submit = form.locator('[type="submit"]');
      await submit.click();
      await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('不可用'));
      assert.equal(await form.locator('textarea').inputValue(), message, '失败后不能丢失草稿');
      assert.equal(await form.locator('[name="email"]').inputValue(), 'browser-reader@example.org');
      assert.equal(await form.locator('[name="parentId"]').inputValue(), parentId || '', '失败后不能丢失回复对象');
      await submit.click();
      await page.waitForFunction(() => document.querySelector('[data-comment-form] fieldset').disabled);
      await submit.evaluate(button => { button.click(); button.click(); });
      release();
      await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('评论已送交审核'));
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
      assert.equal(await form.locator('[name="parentId"]').inputValue(), '');
      assert.equal(await form.locator('[data-reply-context]').isHidden(), true);
      assert.equal(await page.locator('.comment-list > li').count(), initialCount, '待审评论不应直接显示');
      assert.equal(await page.evaluate(() => window.commentXSS), undefined);
      assert.equal(await page.locator('[data-comments] img, [data-comments] script').count(), 0, '留言和回复昵称不能变成 HTML');
      if (parentId) {
        // 回复成功后，继续发顶层留言，不应沿用上次的父编号。
        await form.locator('[name="name"]').fill('顶层读者');
        await form.locator('[name="message"]').fill('新的独立留言');
        await form.locator('[name="consent"]').check();
        await submit.click();
        await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('评论已送交审核'));
        assert.equal(submissions.length, 3);
        assert.equal(submissions[2].parentId, undefined);
        assert.equal(submissions[2].email, undefined, '不填写邮箱也可提交');
        assert.notEqual(submissions[2].id, submissions[1].id);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('[data-comments]').screenshot({ path: path.join(artifacts, `comments-${mode}-${width}.png`) });
      assert.deepEqual(errors, []);
    } finally { release(); await context.close(); }
  }

  // Exercise the actual emitted worker at the default odd-nibble difficulty,
  // then inject bounded failure cases only for cancellation/timeout scenarios.
  const proofPage = await browser.newPage();
  try {
    await proofPage.goto(new URL('p/ai-random-thoughts/', baseURL).href);
    const workerURL = await proofPage.locator('[data-comment-form]').getAttribute('data-pow-worker');
    const sample = { id: 'ae251682-6cc0-40df-bf31-6d48c12a985c', path: '/p/example/', name: '验证', message: '测试', createdAt: new Date().toISOString() };
    const task = issueProof(sample, new URL(baseURL), { ...powEnv, COMMENTS_POW_DIFFICULTY: '5' }, Date.now());
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
    verifyProof({ token: task.token, nonce: result.nonce }, sample, new URL(baseURL), { ...powEnv, COMMENTS_POW_DIFFICULTY: '5' }, Date.now());
    console.log(`真实 Worker 难度 5：${result.elapsed.toFixed(0)} ms（本机单次样本，不代表移动设备性能）`);
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
      await form.locator('[name="name"]').fill('草稿');
      await form.locator('[name="message"]').fill(message);
      await form.locator('[name="consent"]').check();
      await form.locator('[type="submit"]').click();
      if (scenario === 'cancel' || scenario === 'pagehide') {
        await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('已用'));
        if (scenario === 'cancel') await form.locator('[data-cancel-proof]').click();
        else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      }
      const expected = { cancel: '已取消', pagehide: '已取消', timeout: '未能完成', 'worker-error': '未能完成', 'challenge-unavailable': '暂时不可用', 'expired-proof': '已过期', unsupported: '不支持' }[scenario];
      await page.waitForFunction(expected => document.querySelector('.comment-status').textContent.includes(expected), expected);
      assert.equal(await form.locator('[name="message"]').inputValue(), message);
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
  for (const button of await noJS.locator('[data-reply-id]').all()) assert.equal(await button.isHidden(), true);
  if (process.env.SHIUE_TEST_REQUIRE_REPLIES === '1') assert.ok(await noJS.locator('.comment-replies .comment-message').count() >= 6, '无 JS 时多层回复仍可阅读');
  await noJS.close();
  console.log(`评论浏览器检查通过：选填邮箱校验、多层回复、真实 PoW、取消/超时/失败关闭、草稿保留、幂等重试、浅色/深色、桌面/手机、邮件审批与通知重试、无 JS 展示。截图：${artifacts}`);
} finally { await browser.close(); }
