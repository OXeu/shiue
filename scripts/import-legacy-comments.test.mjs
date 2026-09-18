import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildImportPlan, contentHash, selectComments, SOURCE } from './import-legacy-comments.mjs';

const record = (id, changes = {}) => ({ id, content: '有点慢', guestName: '读者', guestEmail: 'private@example.org', guestWebsite: 'https://private.example.org', approved: 1, createdAt: '2025-01-01T00:00:00.000Z', ...changes });

test('duplicate submissions keep the earliest record without merging distinct authors', () => {
  const selected = selectComments(12, [
    record(3, { createdAt: '2025-01-01T00:00:03.000Z' }), record(2), record(1),
    record(4, { guestName: '另一个读者' }),
    record(5, { user: { id: 1, username: '读者', avatar: 'https://private.example.org/avatar' } }),
  ]);
  assert.deepEqual(selected.accepted.map(comment => comment.legacy.commentId), [1, 4, 5]);
  assert.deepEqual(selected.duplicates.map(({ commentId, duplicateOf }) => [commentId, duplicateOf]), [[2, 1], [3, 1]]);
  assert.ok(!JSON.stringify(selected).includes('private'));
});

test('reviewed exclusions are content-bound; brief feedback and technical test discussions remain', () => {
  const exclusions = [{ feedId: 12, commentId: 1, contentSha256: contentHash('TEST'), reason: '测试留言' }];
  const selected = selectComments(12, [record(1, { content: 'TEST' }), record(2), record(3, { content: '不错' }), record(4, { content: '经过测试，图片上传还是失败' }), record(5, { approved: 0 })], exclusions);
  assert.deepEqual(selected.accepted.map(comment => comment.message), ['有点慢', '不错', '经过测试，图片上传还是失败']);
  assert.equal(selected.filtered.length, 2);
  assert.throws(() => selectComments(12, [record(1, { content: '修改后的有效评论' })], exclusions), /重新复核/);
  assert.equal(selectComments(14, [record(1, { content: 'TEST' })], exclusions).accepted.length, 1, '过滤决定不能串文章');
});

test('public author, original text and timestamp survive while unknown reply schemas fail explicitly', () => {
  const content = '  @另一个读者 回复内容\r\n<script>not executed</script>  ';
  const selected = selectComments(12, [record(1, { content, user: { id: 1, username: 'Xeu' }, createdAt: '2025-01-01T08:00:00+08:00' })]);
  assert.equal(selected.accepted[0].name, 'Xeu');
  assert.equal(selected.accepted[0].message, content);
  assert.equal(selected.accepted[0].createdAt, '2025-01-01T00:00:00.000Z');
  assert.equal(selected.accepted[0].parentId, undefined, '不得从 @昵称 猜测父评论');
  assert.throws(() => selectComments(12, [record(1), record(1)]), /重复编号/);
  assert.throws(() => selectComments(12, [record(1, { parentId: 2 })]), /回复层级/);
});

test('import plans match aliases, preserve existing files and reuse IDs on repeated imports', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'xeu-legacy-import-'));
  const directory = path.join(repository, 'content/post/example');
  await mkdir(path.join(directory, 'comments'), { recursive: true });
  await writeFile(path.join(directory, 'index.md'), '---\naliases:\n- /feed/12/\nslug: example\ntitle: 示例\n---\n正文');
  const native = { id: 'e2ae8335-89b2-4f10-97db-cdb4603d23f4', path: '/p/example/', name: '新读者', message: '新评论', createdAt: '2026-01-01T00:00:00.000Z' };
  const nativeFile = path.join(directory, 'comments', `${native.id}.json`);
  await writeFile(nativeFile, JSON.stringify(native));
  const input = { repository, feeds: [{ id: 12, title: '示例' }], commentsByFeed: { 12: [record(1)] } };
  const first = await buildImportPlan(input);
  assert.equal(first.added, 1);
  const comment = JSON.parse(first.files[0].content);
  assert.equal(comment.path, '/p/example/');
  assert.deepEqual(comment.legacy, { source: SOURCE, feedId: 12, commentId: 1 });
  assert.deepEqual(Object.keys(comment).sort(), ['createdAt', 'id', 'legacy', 'message', 'name', 'path']);
  await writeFile(path.join(repository, first.files[0].path), first.files[0].content);
  const repeated = await buildImportPlan(input);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.existing, 1);
  assert.equal(await readFile(nativeFile, 'utf8'), JSON.stringify(native));
  await assert.rejects(buildImportPlan({ ...input, commentsByFeed: { 12: [record(1, { content: 'changed' })] } }), /拒绝覆盖/);
  await assert.rejects(buildImportPlan({ ...input, feeds: [{ id: 12, title: '不同文章' }] }), /无法准确匹配/);
});
