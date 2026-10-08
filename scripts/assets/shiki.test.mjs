import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { load } from 'cheerio';
import { extractCodeBlocks, prepareShiki, resolveLanguage } from './shiki.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);

test('extracts nested fences, normalizes CRLF and excludes front matter', () => {
  const input = [
    '---', 'description: |', '  ```js', '  ignore()', '  ```', '---', '',
    '> ```Kotlin', '> val value = 1', '> ```', '',
    '1. Example', '', '   ```CSS', '   a { color: red; }', '   ```', '',
    '~~~~text', '```', 'keep shorter fences', '```', '~~~~', '',
    '```js {title="Example"}', 'const value = 1', '```', '',
  ].join('\r\n');
  assert.deepEqual(extractCodeBlocks(input), [
    { language: 'kotlin', source: 'val value = 1' },
    { language: 'css', source: 'a { color: red; }' },
    { language: 'text', source: '```\nkeep shorter fences\n```' },
    { language: 'js', source: 'const value = 1' },
  ]);
});

test('handles unclosed and empty fences without treating indented code as fences', () => {
  assert.deepEqual(extractCodeBlocks('```\n```\n\n    indented()\n\n```js\nopen()'), [
    { language: '', source: '' },
    { language: 'js', source: 'open()' },
  ]);
});

test('resolves existing language labels and falls back for unknown languages', () => {
  for (const language of ['Kotlin', 'CSS', 'Groovy', 'js', 'py']) {
    assert.equal(resolveLanguage(language), language.toLowerCase());
  }
  assert.equal(resolveLanguage('shell'), 'shellscript');
  assert.equal(resolveLanguage('clike'), 'c');
  assert.equal(resolveLanguage('plaintext'), 'text');
  assert.equal(resolveLanguage(''), 'text');
  assert.equal(resolveLanguage('unknown-language'), 'text');
});

test('renders both themes safely, preserves copy text and restores cached manifests', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiue-shiki-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  await mkdir(content);
  const source = 'const html = "<script>alert(1)</script>";\n';
  const article = `\`\`\`JS\n${source}\n\`\`\`\n\n\`\`\`unknown-language\n<&>\n\`\`\`\n\n\`\`\`\nplain text\n\`\`\`\n`;
  await writeFile(path.join(content, 'first.md'), article);
  await writeFile(path.join(content, 'duplicate.md'), article);

  const logs = [];
  const options = { log: message => logs.push(message) };
  const manifest = await prepareShiki(root, options);
  assert.equal(Object.keys(manifest).length, 3);
  for (const html of Object.values(manifest)) {
    const $ = load(html);
    assert.equal($('pre.shiki.github-light.github-dark[tabindex="0"]').length, 1);
    assert.match($('pre').attr('style'), /--shiki-dark:/);
    assert.equal($('script').length, 0);
  }
  const highlighted = Object.values(manifest).find(html => html.includes('language-js'));
  const $ = load(highlighted);
  assert.equal($('code').text(), source);
  assert.ok($('code span[style*="--shiki-dark"]').length > 1);
  assert.ok(Object.values(manifest).some(html => load(html)('code').text() === '<&>'));

  const manifestFile = path.join(root, 'data/xeu/shiki.json');
  const cacheFile = path.join(root, '.cache/xeu-shiki/code.json');
  const modified = (await stat(manifestFile)).mtimeMs;
  assert.deepEqual(await prepareShiki(root, options), manifest);
  assert.match(logs.at(-1), /缓存复用 3 个 · 新生成 0 个/);
  assert.equal((await stat(manifestFile)).mtimeMs, modified);

  await rm(manifestFile);
  assert.deepEqual(await prepareShiki(root, options), manifest);
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest);
  assert.match(logs.at(-1), /新生成 0 个/);

  await writeFile(cacheFile, 'invalid JSON');
  assert.deepEqual(await prepareShiki(root, options), manifest);
  assert.match(logs.at(-1), /新生成 3 个/);

  await writeFile(path.join(content, 'first.md'), '```js\nconst changed = 2;\n```\n');
  await rm(path.join(content, 'duplicate.md'));
  const updated = await prepareShiki(root, options);
  assert.equal(Object.keys(updated).length, 1);
  assert.equal(load(Object.values(updated)[0])('code').text(), 'const changed = 2;');
  assert.match(logs.at(-1), /新生成 1 个/);
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(cache.blocks), Object.keys(updated));
});

test('Hugo renders the static highlights with matching nested code and empty lines', async t => {
  let hugo;
  try {
    const { stdout } = await run('bash', [path.join(projectRoot, 'scripts/hugo.sh'), '--resolve'], {
      env: { ...process.env, SHIUE_HUGO_OFFLINE: '1' },
    });
    hugo = stdout.trim();
  } catch {
    t.skip('Hugo Extended is not installed or cached; run npm run build first');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiue-shiki-hugo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['content', 'layouts/_default/_markup', 'layouts/partials']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  const markup = await readFile(path.join(projectRoot, 'config/_default/markup.toml'), 'utf8');
  await writeFile(path.join(root, 'hugo.toml'), `baseURL="https://example.com/"\ndisableKinds=["taxonomy","term","rss","sitemap"]\n[markup]\n${markup}`);
  for (const name of ['single', 'list']) {
    await writeFile(path.join(root, `layouts/_default/${name}.html`), '<main class="prose">{{ .Content }}</main>');
  }
  await copyFile(path.join(projectRoot, 'themes/xeu/layouts/_default/_markup/render-codeblock.html'), path.join(root, 'layouts/_default/_markup/render-codeblock.html'));
  await copyFile(path.join(projectRoot, 'themes/xeu/layouts/partials/code-highlight.html'), path.join(root, 'layouts/partials/code-highlight.html'));
  const input = [
    '```JS', 'const html = "<&>";', '    ', 'console.log(html);', '```', '',
    '1. Example', '', '   ```CSS', '   a { color: red; }', '       ', '   b {}', '   ```', '',
    '   > ```js', '   > const quoted = 1;', '   >     ', '   > const end = 2;', '   > ```', '',
    '```unknown-language', '<script>alert(1)</script>', '```', '',
    '```', '```', '', '~~~~text', '```', '~~~~', '',
  ].join('\r\n');
  await writeFile(path.join(root, 'content/example.md'), input);
  await prepareShiki(root, { log() {} });
  await run(hugo, ['--source', root]);
  const $ = load(await readFile(path.join(root, 'public/example/index.html'), 'utf8'));
  const blocks = extractCodeBlocks(input);
  assert.equal($('.code-block pre.shiki code').length, blocks.length);
  assert.equal($('.copy-code').length, blocks.length);
  $('.code-block pre.shiki code').each((index, node) => assert.equal($(node).text(), blocks[index].source));
  assert.equal($('script').length, 0);
});
