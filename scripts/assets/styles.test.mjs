import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { load } from 'cheerio';
import { optimizeCSS, optimizeStyles } from './styles.mjs';

test('prunes unused rules, tokens and keyframes while preserving runtime states', async () => {
  const css = `
    :root { --unused: red; --color: black; --alias: var(--color); --columns-max: 4; }
    :root[data-color-mode="dark"] { --color: white; }
    .present { color: var(--alias); }
    .runtime-card[aria-current="location"] { border: 0; }
    .missing { color: var(--unused); animation: unused 1s; }
    .present.has-status { animation: spin 1s; }
    ::view-transition-new(article-panel) { animation: arrive 1s; }
    @keyframes unused { to { opacity: 0; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes arrive { from { opacity: 0; } }
    @media (max-width: 600px) { .present { padding: 2px; } .missing { margin: 1px; } }
  `;
  const code = String(await optimizeCSS(css, [
    { raw: '<div class="present"></div>', extension: 'html' },
    { raw: 'node.classList.add("has-status"); make("runtime-card");', extension: 'js' },
  ], ['--columns-max']));
  for (const unused of ['.missing', '--unused', '@keyframes unused']) assert.ok(!code.includes(unused), unused);
  for (const retained of ['--color:', '--alias:', '--columns-max:', 'dark', 'runtime-card', 'location', 'has-status', '@keyframes spin', '@keyframes arrive', 'view-transition-new(article-panel)', '@media']) {
    assert.ok(code.includes(retained), retained);
  }
});

test('shares feature styles, preserves deferred dependencies, and updates fingerprints under a baseURL subpath', async t => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'shiue-styles-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await mkdir(path.join(destination, 'css'));
  await mkdir(path.join(destination, 'js'));
  const asset = async (directory, name, source) => {
    const hash = createHash('sha256').update(source).digest('hex');
    const file = `${directory}/${name}.${hash}.${directory}`;
    await writeFile(path.join(destination, file), source);
    return `/blog/${file}`;
  };
  const css = await asset('css', 'xeu.min', ':root { --popup: pink; --unused: red; --columns-max: 4; } .first { color: black; } .second { color: blue; } .search-only { margin: 0; } .runtime-card { padding: 1px; } .unused { color: red; }');
  const script = await asset('js', 'post', 'create("runtime-card"); styles.getPropertyValue("--columns-max");');
  const search = await asset('js', 'search-page', 'create("search-only");');
  const lazyScript = await asset('js', 'comments', 'node.classList.add("has-status");');
  const lazyStyle = await asset('css', 'comment-editor.min', '.popup.has-status { color: var(--popup); } .unused-popup { color: red; }');
  const template = `<template data-lazy-feature=comments data-script="${lazyScript}" data-integrity="unchanged" data-stylesheet='${lazyStyle}' data-stylesheet-integrity=old></template>`;
  const page = (className, scripts, deferred = '') => `<!doctype html><html><head><link rel=stylesheet href=${css} integrity=old></head><body><p class="${className}">原文 &amp; 内容</p>${deferred}<script src="${scripts}"></script></body></html>`;
  const originals = [page('first popup', script, template), page('second popup', script, template), page('search-only', search)];
  await Promise.all(originals.map((html, i) => writeFile(path.join(destination, `${i}.html`), html)));
  await writeFile(path.join(destination, 'alias.html'), '<meta http-equiv="refresh" content="0;url=/blog/">');
  const result = await optimizeStyles(destination);
  assert.equal(result.pages, 3);
  assert.equal(result.stylesheets, 3);
  const documents = await Promise.all(originals.map((_, i) => readFile(path.join(destination, `${i}.html`), 'utf8')));
  const links = documents.map(html => load(html)('link').attr('href'));
  assert.equal(links[0], links[1]);
  assert.notEqual(links[0], links[2]);
  const postCSS = await readFile(path.join(destination, links[0].replace('/blog/', '')), 'utf8');
  for (const retained of ['.first', '.second', '.runtime-card', '--popup:', '--columns-max:']) assert.ok(postCSS.includes(retained), retained);
  for (const removed of ['.search-only', '.unused', '--unused:']) assert.ok(!postCSS.includes(removed), removed);
  const searchCSS = await readFile(path.join(destination, links[2].replace('/blog/', '')), 'utf8');
  assert.ok(!searchCSS.includes('.first'));
  assert.ok(!searchCSS.includes('--popup:'));
  for (let i = 0; i < documents.length; i++) {
    const $ = load(documents[i]);
    for (const element of $('link, template').toArray()) {
      const lazy = $(element).is('template');
      const url = $(element).attr(lazy ? 'data-stylesheet' : 'href');
      assert.ok(url.startsWith('/blog/css/'));
      const code = await readFile(path.join(destination, url.replace('/blog/', '')));
      const digest = createHash('sha256').update(code).digest();
      assert.ok(url.includes(digest.toString('hex')));
      assert.equal($(element).attr(lazy ? 'data-stylesheet-integrity' : 'integrity'), `sha256-${digest.toString('base64')}`);
      if (lazy) {
        assert.equal($(element).attr('data-script'), lazyScript);
        assert.ok(String(code).includes('.popup.has-status'));
        assert.ok(!String(code).includes('unused-popup'));
      }
    }
    const withoutAssets = html => html.replace(/<(?:link|template)\b[^>]*>/g, '');
    assert.equal(withoutAssets(documents[i]), withoutAssets(originals[i]));
  }
  assert.ok(!(await readdir(path.join(destination, 'css'))).some(file => file.includes('.min.')));
  // Optimization remains stable when a cached output is processed again.
  await optimizeStyles(destination);
  for (let i = 0; i < documents.length; i++) assert.equal(await readFile(path.join(destination, `${i}.html`), 'utf8'), documents[i]);
});
