import assert from 'node:assert/strict';
import { handleSubmission } from '../server/submissions.js';
import { mockSiteverify } from './fixtures/turnstile.mjs';
import { turnstileScript } from './fixtures/turnstile-browser.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.SHIUE_TEST_URL || 'http://127.0.0.1:1313/');
const site = new URL(base);
site.protocol = 'https:';
const article = new URL('p/ai-random-thoughts/', base);
const key = `xeu-comment-draft:v1:${encodeURIComponent(article.pathname)}:root`;
const env = {
  COMMENTS_SITE_URL: site.href, COMMENTS_SECRET: 'draft-regression-secret'.repeat(3),
  TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret-key',
  RESEND_API_KEY: 'test-key', COMMENTS_EMAIL_FROM: 'blog@example.org', COMMENTS_EMAIL_TO: 'owner@example.org',
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ reducedMotion: 'reduce' });
const errors = [];
const submissions = [];
const emails = [];
let failMail = false;
let mailGate;
let challengeGate;
let challengeReady;
let release;
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: turnstileScript() });
  if (url.origin !== base.origin) return route.abort();
  if (url.pathname !== '/api/submissions') return route.continue();
  const body = route.request().postDataJSON();
  if (body.action === 'submit') submissions.push(body);
  if (body.action === 'challenge' && challengeGate) {
    challengeReady();
    await challengeGate;
  }
  const response = await handleSubmission(new Request(new URL('/api/submissions', site), {
    method: 'POST', headers: { origin: site.origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), {
    env, deployment: 'production',
    pages: async () => [{ path: article.pathname, title: '草稿回归', directory: 'post/ai-random-thoughts' }],
    fetchImpl: mockSiteverify(async (url, init) => {
      assert.equal(url, 'https://api.resend.com/emails');
      emails.push(init);
      if (mailGate) await mailGate;
      return failMail ? new Response(null, { status: 503 }) : Response.json({ id: 'receipt' });
    }),
  });
  return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});
const form = page => page.locator('[data-comment-form]');
const open = page => page.locator('[data-new-comment]').click();
const close = page => page.locator('[data-close-comment]').click();
const submit = page => form(page).locator('[type="submit"]').click();
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
const messageIs = (page, message) => page.waitForFunction(message => document.querySelector('[data-comment-form] textarea').value === message, message);
const statusIs = (page, text) => page.waitForFunction(text => document.querySelector('.comment-status').textContent.includes(text), text);
const fill = async (page, message) => {
  await form(page).locator('[name="name"]').fill('草稿读者');
  await form(page).locator('[name="email"]').fill('reader@example.org');
  await form(page).locator('textarea').fill(message);
  await form(page).locator('[name="consent"]').check();
};
try {
  const a = await context.newPage();
  await a.goto(article.href);
  await open(a);
  await fill(a, '跨天保留的草稿');
  failMail = true;
  await submit(a);
  await statusIs(a, '暂未送达');
  const original = (await stored(a)).pending;
  await a.evaluate(key => {
    const draft = JSON.parse(localStorage.getItem(key));
    draft.pending.createdAt = new Date(Date.now() - 2 * 86400000).toISOString();
    localStorage.setItem(key, JSON.stringify(draft));
  }, key);
  await a.reload();
  await open(a);
  await submit(a);
  await statusIs(a, '暂未送达');
  const renewed = (await stored(a)).pending;
  assert.notEqual(renewed.id, original.id);
  assert.ok(Math.abs(Date.parse(renewed.createdAt) - Date.now()) < 60000);
  await messageIs(a, '跨天保留的草稿');
  await a.reload();
  await open(a);
  failMail = false;
  await submit(a);
  await statusIs(a, '评论已送交审核');
  assert.equal(submissions.at(-1).id, renewed.id);
  assert.equal(submissions.at(-1).createdAt, renewed.createdAt);
  assert.equal(emails.at(-1).headers['idempotency-key'], emails.at(-2).headers['idempotency-key']);
  assert.equal(await stored(a), null);
  await close(a);
  await open(a);

  // A second tab sees edits and successful deletion without refreshing.
  await fill(a, '两个标签页打开同一草稿');
  const b = await context.newPage();
  await b.goto(article.href);
  await open(b);
  await messageIs(b, '两个标签页打开同一草稿');
  await form(a).locator('textarea').fill('同步后的草稿');
  await messageIs(b, '同步后的草稿');
  await submit(a);
  await statusIs(a, '评论已送交审核');
  await messageIs(b, '');
  await b.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await close(b);
  await b.reload();
  await open(b);
  await messageIs(b, '');
  assert.equal(await stored(b), null, 'closing an old tab must not resurrect a submitted draft');
  await close(a);
  await open(a);

  // Simulate a suspended tab missing storage notifications until it resumes.
  await fill(a, '暂挂标签页的草稿');
  await messageIs(b, '暂挂标签页的草稿');
  await b.evaluate(() => window.addEventListener('storage', event => event.stopImmediatePropagation(), true));
  await submit(a);
  await statusIs(a, '评论已送交审核');
  await b.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await stored(b), null, 'an unchanged stale form must never be written back');
  await b.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await messageIs(b, '');
  await b.reload();
  await open(b);
  await close(a);
  await open(a);

  // A submission only clears its own version, preserving edits made in flight.
  await fill(a, '正在发送的版本');
  await messageIs(b, '正在发送的版本');
  mailGate = new Promise(resolve => { release = resolve; });
  await submit(a);
  await statusIs(a, '正在提交');
  await form(b).locator('textarea').fill('另一标签页的新内容');
  release();
  mailGate = undefined;
  await statusIs(a, '评论已送交审核');
  assert.equal((await stored(a)).message, '另一标签页的新内容');
  await a.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal((await stored(a)).message, '另一标签页的新内容');
  await close(a);
  await open(a);
  await messageIs(a, '另一标签页的新内容');

  // Inactive reply drafts must survive a root submission; cached root drafts
  // must not return when switching back from a reply in the other tab.
  const reply = b.locator('[data-reply-id]').first();
  assert.ok(await reply.count(), 'run against the comment fixtures produced by check-build');
  await close(b);
  await reply.click();
  await form(b).locator('textarea').fill('独立的回复草稿');
  await submit(a);
  await statusIs(a, '评论已送交审核');
  await messageIs(b, '独立的回复草稿');
  await close(b);
  await open(b);
  await messageIs(b, '');
  assert.equal(await stored(b), null);
  await close(b);
  await reply.click();
  await messageIs(b, '独立的回复草稿');

  // Renewing metadata after a slow challenge must also preserve another tab's
  // edits, not just edits made once the moderation email is being sent.
  await close(a);
  await open(a);
  await fill(a, '等待续期的版本');
  failMail = true;
  await submit(a);
  await statusIs(a, '暂未送达');
  await a.evaluate(key => {
    const draft = JSON.parse(localStorage.getItem(key));
    draft.pending.createdAt = new Date(Date.now() - 2 * 86400000).toISOString();
    localStorage.setItem(key, JSON.stringify(draft));
    window.dispatchEvent(new Event('pageshow'));
  }, key);
  await close(b);
  await open(b);
  const challengeRequested = new Promise(resolve => { challengeReady = resolve; });
  challengeGate = new Promise(resolve => { release = resolve; });
  await submit(a);
  await challengeRequested;
  await form(b).locator('textarea').fill('续期过程中写的新内容');
  failMail = false;
  release();
  challengeGate = undefined;
  await statusIs(a, '评论已送交审核');
  assert.equal((await stored(a))?.message, '续期过程中写的新内容');
  await messageIs(b, '续期过程中写的新内容');
  assert.deepEqual(errors, []);
  console.log('草稿回归通过：过期自动续期、失败刷新重试幂等、多标签同步、暂停页防回写、发送期间编辑保护、回复草稿隔离。');
} finally {
  release?.();
  await browser.close();
}
