// 新建文章向导（npm run post:new）。
//
// 交互式创建 content/post/<slug>/index.md，无任何依赖；标题必填，
// 其余可回车跳过。front matter 用 JSON 语法书写（JSON 是合法的 YAML），
// 天然安全引用用户输入。已有目录不会被覆盖。

import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posts = path.join(repo, 'content', 'post');

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** 中英文逗号、顿号分隔的列表，去重去空。 */
function list(value) {
  return [...new Set(value.split(/[,，、]/).map(item => item.trim()).filter(Boolean))];
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(`用法：npm run post:new -- ["文章标题"]

交互式创建 content/post/<slug>/index.md，无需安装依赖或 Hugo。
标题必填，其余提示可按回车使用默认值或留空。
分类与标签填写英文标识，用中文或英文逗号分隔；默认保存为草稿。
封面可填写文章目录内的文件名、/ 开头的静态资源路径或图片网址。
Ctrl+C 或输入结束时取消；已有文章目录不会被覆盖。`);
    return;
  }
  if (positionals.length > 1) throw new Error('只接受一个标题参数；带空格的标题请用引号包裹。');

  const rl = createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
  // 异步迭代器：粘贴或管道输入的多行答案也能按序消费。
  const lines = rl[Symbol.asyncIterator]();
  let cancelled = false;
  const cancel = () => { cancelled = true; rl.close(); };
  rl.on('SIGINT', cancel);
  process.once('SIGINT', cancel);

  /** 单个提问：显示默认值，validate 返回错误文案则重新提问。 */
  async function ask(label, fallback = '', validate = () => '') {
    while (true) {
      rl.setPrompt(`${label}${fallback ? ` [${fallback}]` : ''}：`);
      rl.prompt();
      const answer = await lines.next();
      if (cancelled || answer.done) {
        const error = new Error('已取消，未创建文章。');
        error.code = 'CANCELLED';
        throw error;
      }
      const value = answer.value.trim() || fallback;
      const error = await validate(value);
      if (!error) return value;
      console.log(`  ${error}`);
    }
  }

  let file;
  let draft;
  try {
    console.log('新建文章 · 回车使用默认值或跳过可选项，Ctrl+C 取消。\n');
    const title = positionals[0]?.trim() || await ask('文章标题', '', value => value ? '' : '标题不能为空。');

    // slug 默认从标题转写；无英文字符时退回时间戳。
    const suggestedSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      || `post-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const slug = await ask('网址名 slug（小写英文、数字、连字符）', suggestedSlug, async value => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return '请使用小写英文或数字，单词之间用连字符连接，例如 hello-world。';
      if (await exists(path.join(posts, value))) return '该文章目录已存在，请换一个网址名。';
      return '';
    });

    const description = await ask('文章摘要（可选）');
    // 分类与标签必须是英文标识；中文显示名在对应 _index.md 的 title 设置。
    const validateTerms = value => list(value).every(term => /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/i.test(term))
      ? ''
      : '分类与标签请填写英文标识，例如 tech、essays、blog；中文显示名称在对应 _index.md 的 title 中设置。';
    const categories = list(await ask('分类（英文标识，可选，逗号分隔）', '', validateTerms));
    const tags = list(await ask('标签（英文标识，可选，逗号分隔）', '', validateTerms));
    const image = await ask('封面（可选，如 cover.jpg）');
    const answer = await ask('保存为草稿？Y/n', 'Y', value =>
      /^(y|yes|n|no|是|否)$/i.test(value) ? '' : '请输入 y（草稿）或 n（发布）。');
    draft = /^(y|yes|是)$/i.test(answer);

    // front matter 用 JSON 语法：合法 YAML 且自动安全引用。
    const metadata = {
      title,
      date: new Date().toISOString(),
      description,
      slug,
      ...(image ? { image } : {}),
      categories,
      tags,
      draft,
    };
    const content = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n<!-- 在这里开始写正文 -->\n`;

    // 目录必须新建（EEXIST 即拒绝），文件也以 wx 创建，双保险不覆盖。
    const directory = path.join(posts, slug);
    await mkdir(posts, { recursive: true });
    try { await mkdir(directory); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`文章目录已存在，未覆盖：${directory}`);
      throw error;
    }
    file = path.join(directory, 'index.md');
    await writeFile(file, content, { flag: 'wx' });
  } finally {
    rl.close();
    process.removeListener('SIGINT', cancel);
  }

  console.log(`\n已创建${draft ? '草稿' : '文章'}：${file}`);
  console.log('图片可放在文章所在目录，正文通过相对路径引用。');
  console.log(`在仓库根目录预览：npm run dev${draft ? ' -- --buildDrafts' : ''}`);
  if (draft) console.log('写完后将 index.md 中的 draft 改为 false，再提交发布。');
}

main().catch(error => {
  console.error(`\n${error.message}`);
  process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
});
