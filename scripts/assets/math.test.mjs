import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { load } from 'cheerio';
import { extractMath, mathKey, prepareMath } from './math.mjs';

test('extracts display and inline formulas, ignoring front matter and code', () => {
  const input = [
    '---', 'description: 使用 $x$ 的地方', '---', '',
    '行内 \\(a^2 + b^2 = c^2\\) 结束。', '',
    '$$', '\\begin{aligned}', '  a &= b \\\\', '\\end{aligned}', '$$', '',
    '代码里的 $x$ 与 $$y$$ 不算公式：', '',
    '```md', '$$', 'not math', '$$', '\\(also not\\)', '```', '',
  ].join('\r\n');
  assert.deepEqual(extractMath(input), [
    { type: 'block', source: '\\begin{aligned}\n  a &= b \\\\\n\\end{aligned}' },
    { type: 'inline', source: 'a^2 + b^2 = c^2' },
  ]);
});

test('keeps displayed and inline formulas with the same source apart', () => {
  assert.notEqual(
    mathKey({ type: 'block', source: 'x' }),
    mathKey({ type: 'inline', source: 'x' }),
  );
  assert.equal(
    mathKey({ type: 'inline', source: 'x' }),
    mathKey({ type: 'inline', source: 'x' }),
  );
});

test('renders readable SVG whose ids are stable and namespaced', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiue-math-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  await mkdir(content);
  const formula = '\\frac{a}{b}';
  await writeFile(path.join(content, 'first.md'), `行内 \\(${formula}\\) 与 \\(x\\) 结束。\n`);
  await writeFile(path.join(content, 'second.md'), `再次引用 \\(${formula}\\)。\n\n$$\n\\sum_{i=0}^{n} i\n$$\n`);

  const logs = [];
  const options = { log: message => logs.push(message) };
  const manifest = await prepareMath(root, options);
  assert.equal(Object.keys(manifest).length, 3);

  for (const [key, svg] of Object.entries(manifest)) {
    assert.ok(svg.startsWith('<svg '), key);
    assert.ok(!/<script|<foreignObject/i.test(svg), key);
    const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.ok(ids.length > 0, key);
    const prefix = ids[0].replace(/-\d+$/, '');
    assert.match(prefix, /^xeu-math-[a-f0-9]{24}$/);
    // 同页内联多个公式时，各自的 id 都带内容指纹，不会互相覆盖。
    ids.forEach((id, index) => assert.equal(id, `${prefix}-${index}`));
    for (const reference of svg.matchAll(/xlink:href="#([^"]+)"/g)) {
      assert.ok(ids.includes(reference[1]), reference[1]);
    }
  }
  const inline = load(manifest[mathKey({ type: 'inline', source: formula })]);
  assert.equal(inline('svg').length, 1);
  // 同一公式出现在两篇文章中只渲染一次，产物完全相同。
  assert.equal(manifest[mathKey({ type: 'inline', source: formula })], manifest[mathKey({ type: 'inline', source: formula })]);

  const manifestFile = path.join(root, 'data/xeu/math.json');
  const modified = (await stat(manifestFile)).mtimeMs;
  assert.deepEqual(await prepareMath(root, options), manifest);
  assert.match(logs.at(-1), /缓存复用 3 个 · 新生成 0 个/);
  assert.equal((await stat(manifestFile)).mtimeMs, modified);

  await rm(manifestFile);
  assert.deepEqual(await prepareMath(root, options), manifest);
  assert.match(logs.at(-1), /缓存复用 3 个 · 新生成 0 个/);
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest);

  await writeFile(path.join(content, 'first.md'), '换成 \\(y\\) 结束。\n');
  const updated = await prepareMath(root, options);
  assert.equal(Object.keys(updated).length, 3);
  // 公式仍被第二篇文章引用，因此保留；只有不再出现的 \(x\) 被清理。
  assert.ok(mathKey({ type: 'inline', source: formula }) in updated);
  assert.ok(!(mathKey({ type: 'inline', source: 'x' }) in updated));
  assert.ok(mathKey({ type: 'inline', source: 'y' }) in updated);
  assert.match(logs.at(-1), /新生成 1 个/);
});

test('reports a readable error for invalid TeX', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiue-math-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  await mkdir(content);
  await writeFile(path.join(content, 'bad.md'), '$$\n\\frac{a\n$$\n');
  await assert.rejects(prepareMath(root, { log() {} }), /公式渲染失败/);
});
