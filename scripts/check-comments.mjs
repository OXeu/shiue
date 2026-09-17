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
      const submit = form.locator('[type="submit"]');
      await submit.click();
      await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('不可用'));
      assert.equal(await form.locator('textarea').inputValue(), message, '失败后不能丢失草稿');
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
      assert.equal(submissions[1].path, new URL('p/ai-random-thoughts/', baseURL).pathname);
      assert.equal(await form.locator('textarea').inputValue(), '');
      assert.equal(await page.locator('.comment-list > li').count(), initialCount, '待审评论不应直接显示');
      assert.equal(await page.evaluate(() => window.commentXSS), undefined);
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

  for (const scenario of ['cancel', 'pagehide', 'timeout', 'worker-error', 'challenge-rate-limit', 'expired-proof', 'unsupported']) {
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
      if (scenario === 'challenge-rate-limit') return route.fulfill({ status: 429, json: { error: '操作过于频繁，请稍后重试。' } });
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
      await form.locator('[name="name"]').fill('草稿');
      await form.locator('[name="message"]').fill(message);
      await form.locator('[name="consent"]').check();
      await form.locator('[type="submit"]').click();
      if (scenario === 'cancel' || scenario === 'pagehide') {
        await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('已用'));
        if (scenario === 'cancel') await form.locator('[data-cancel-proof]').click();
        else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      }
      const expected = { cancel: '已取消', pagehide: '已取消', timeout: '未能完成', 'worker-error': '未能完成', 'challenge-rate-limit': '过于频繁', 'expired-proof': '已过期', unsupported: '不支持' }[scenario];
      await page.waitForFunction(expected => document.querySelector('.comment-status').textContent.includes(expected), expected);
      assert.equal(await form.locator('[name="message"]').inputValue(), message);
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
    if (body.action === 'preview') return route.fulfill({ json: { comment: { name: '<script>name</script>', message, createdAt: '2026-09-17T20:00:00.000Z' }, title: '审核测试', url: new URL('p/ai-random-thoughts/', baseURL).href } });
    if (actions.filter(action => action === 'approve').length === 1) return route.fulfill({ status: 502, json: { error: '任务未被接受，请重试。' } });
    return route.fulfill({ status: 202, json: { message: '已提交发布任务，等待部署完成。', actionsURL: 'https://github.com/OXeu/shiue/actions/workflows/publish-comment.yml' } });
  });
  await page.goto(new URL('comment-review/#token=test-approval-token', baseURL).href);
  const approve = page.locator('[data-approve-comment]');
  await approve.waitFor({ state: 'visible' });
  assert.deepEqual(actions, ['preview'], '打开邮件链接不能触发发布');
  assert.equal(new URL(page.url()).hash, '', '审批凭据应立即从地址栏移除');
  assert.equal(await page.locator('[data-review-message]').textContent(), message);
  assert.equal(await page.locator('[data-review-content] img, [data-review-content] script').count(), 0);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('.comment-status').textContent.includes('未被接受'));
  assert.equal(await approve.isEnabled(), true);
  await approve.click();
  await approve.waitFor({ state: 'hidden' });
  assert.deepEqual(actions, ['preview', 'approve', 'approve']);
  assert.equal(await page.locator('[data-workflow-link]').isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'review.png') });
  await page.close();

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(new URL('p/ai-random-thoughts/', baseURL).href);
  assert.equal(await noJS.locator('[data-comments]').isVisible(), true, '无脚本仍能阅读静态评论');
  assert.equal(await noJS.locator('[data-comment-form] [type="submit"]').isDisabled(), true);
  await noJS.close();
  console.log(`评论浏览器检查通过：真实 PoW、取消/超时/失败关闭、草稿保留、幂等重试、浅色/深色、桌面/手机、邮件审批、无 JS 展示。截图：${artifacts}`);
} finally { await browser.close(); }
