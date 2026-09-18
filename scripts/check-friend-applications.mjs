import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { issueProof, verifyProof } from '../server/comments/pow.js';
import { POW_PURPOSE, validateFriend } from '../server/friends/core.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/');
const env = { COMMENTS_POW_SECRET: 'browser-test-only'.repeat(4), COMMENTS_POW_DIFFICULTY: '4' };
const artifacts = await mkdtemp(path.join(tmpdir(), 'xeu-friend-browser-'));
const browser = await chromium.launch({ headless: true });
const title = '<script>我的小站</script>';
const description = '<img src=x onerror="window.friendXSS=true"> 分享生活';
const fill = async page => {
  const form = page.locator('[data-friend-form]');
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="website"]').fill('https://friend.example.org/');
  await form.locator('[name="description"]').fill(description);
  await form.locator('[name="consent"]').check();
  return form;
};
try {
  for (const mode of ['light', 'dark']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(mode => localStorage.setItem('xeu-color-mode', mode), mode);
    const page = await context.newPage();
    const errors = [];
    const submissions = [];
    let challenges = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) return route.abort();
      if (url.pathname === '/api/friends-challenge') {
        challenges++;
        return route.fulfill({ json: issueProof(validateFriend(route.request().postDataJSON()), base, env, Date.now(), POW_PURPOSE) });
      }
      if (url.pathname === '/api/friends-submit') {
        const body = route.request().postDataJSON();
        verifyProof(body.proof, validateFriend(body), base, env, Date.now(), POW_PURPOSE);
        submissions.push(body);
        return submissions.length === 1 ? route.fulfill({ status: 502, json: { error: '申请暂未送达，请重试。' } }) : route.fulfill({ status: 202, json: { message: '友链申请已送交审核，通过并完成部署后会显示在友链列表中。' } });
      }
      return route.continue();
    });
    try {
      await page.goto(new URL('友链/', base).href);
      assert.equal(challenges, 0);
      const count = await page.locator('.friend-card').count();
      const form = await fill(page);
      const submit = form.locator('[type="submit"]');
      await submit.click();
      await page.waitForFunction(() => document.querySelector('[data-friend-form] [role="status"]').textContent.includes('暂未送达'));
      assert.equal(await form.locator('[name="description"]').inputValue(), description);
      await submit.click();
      await submit.evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => document.querySelector('[data-friend-form] [role="status"]').textContent.includes('已送交审核'));
      assert.equal(submissions.length, 2);
      assert.equal(challenges, 2);
      assert.equal(submissions[0].id, submissions[1].id);
      assert.equal(submissions[0].createdAt, submissions[1].createdAt);
      assert.notEqual(submissions[0].proof.token, submissions[1].proof.token);
      assert.equal(await form.locator('[name="title"]').inputValue(), '');
      assert.equal(await page.locator('.friend-card').count(), count);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.locator('.friend-application').screenshot({ path: path.join(artifacts, `application-${mode}-${width}.png`) });
    } finally { await context.close(); }
  }

  for (const scenario of ['cancel', 'unsupported', 'challenge-unavailable', 'expired-proof']) {
    const page = await browser.newPage();
    let submissions = 0;
    if (scenario === 'unsupported') await page.addInitScript(() => { window.Worker = undefined; });
    await page.route('**/api/friends-challenge', route => scenario === 'challenge-unavailable' ? route.fulfill({ status: 503, json: { error: '暂时不可用' } }) : route.fulfill({ json: issueProof(validateFriend(route.request().postDataJSON()), base, env, Date.now(), POW_PURPOSE) }));
    await page.route('**/api/friends-submit', route => { submissions++; return route.fulfill({ status: 410, json: { error: '工作量证明已过期，请重新提交。' } }); });
    if (scenario === 'cancel') await page.route('**/js/comment-pow-worker.*.js', route => route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage=()=>self.postMessage({elapsed:1})' }));
    try {
      await page.goto(new URL('友链/', base).href);
      const form = await fill(page);
      await form.locator('[type="submit"]').click();
      if (scenario === 'cancel') {
        await page.waitForFunction(() => document.querySelector('[data-friend-form] [role="status"]').textContent.includes('已用'));
        await form.locator('[data-cancel-proof]').click();
      }
      const expected = { cancel: '已取消', unsupported: '不支持', 'challenge-unavailable': '不可用', 'expired-proof': '已过期' }[scenario];
      await page.waitForFunction(expected => document.querySelector('[data-friend-form] [role="status"]').textContent.includes(expected), expected);
      assert.equal(await form.locator('[name="title"]').inputValue(), title);
      assert.equal(await form.locator('[type="submit"]').isEnabled(), true);
      assert.equal(await form.locator('[data-cancel-proof]').isHidden(), true);
      assert.equal(submissions, scenario === 'expired-proof' ? 1 : 0);
    } finally { await page.close(); }
  }

  const page = await browser.newPage();
  const actions = [];
  await page.route('**/api/friends-approve', route => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    assert.equal(body.token, 'test-token');
    if (body.action === 'preview') return route.fulfill({ json: { friend: { title, description, website: 'https://friend.example.org/', icon: 'https://friend.example.org/icon.png', createdAt: '2026-09-18T12:00:00.000Z' } } });
    if (actions.length === 2) return route.fulfill({ status: 502, json: { error: '发布失败，请重试。' } });
    return route.fulfill({ status: 202, json: { message: '发布任务已提交', actionsURL: 'https://github.com/owner/blog/actions/workflows/publish-friend.yml' } });
  });
  await page.goto(new URL('friend-review/#token=test-token', base).href);
  const approve = page.locator('[data-approve-friend]');
  await approve.waitFor({ state: 'visible' });
  assert.deepEqual(actions, ['preview']);
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('[data-review-title]').textContent(), title);
  assert.equal(await page.locator('[data-review-content] img, [data-review-content] script').count(), 0);
  assert.equal(await page.evaluate(() => window.friendXSS), undefined);
  await approve.click();
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('失败'));
  await approve.click();
  await approve.waitFor({ state: 'hidden' });
  assert.deepEqual(actions, ['preview', 'approve', 'approve']);
  await page.screenshot({ path: path.join(artifacts, 'review.png') });
  await page.close();

  const noJS = await browser.newPage({ javaScriptEnabled: false });
  await noJS.goto(new URL('友链/', base).href);
  assert.ok(await noJS.locator('.friend-card').count() > 0);
  assert.equal(await noJS.locator('[data-friend-form] [type="submit"]').isDisabled(), true);
  await noJS.close();
  console.log(`友链申请浏览器检查通过：真实 PoW、失败保留草稿、幂等重试、取消、浅深色、桌面手机、邮件预览和确认、无 JS。截图：${artifacts}`);
} finally { await browser.close(); }
