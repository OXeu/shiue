import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { command } from './process.mjs';
import { updateFriendHealth } from './friends.mjs';
import { prepareIdentity, readIdentity, identityAssets } from './identity.mjs';

export function deploymentSteps() {
  return [
    {
      id: 'preflight', title: '环境检查',
      async run(context, { log }) {
        if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('部署脚本需要 Node.js 22 或更新版本');
        for (const file of ['.hugo-version', 'hugo.toml', 'data/friends.json']) await access(path.join(context.root, file));
        log(`Node.js ${process.versions.node} · ${process.platform}/${process.arch}`);
        log(`输出目录：${context.destination}`);
        log(context.offline ? '离线构建：复用本机图标并跳过外网友链检测' : '部署构建：在线刷新站点图标与友链状态，不修改 Git 数据');
        return { node: process.versions.node, destination: context.destination, offline: context.offline };
      },
    },
    {
      id: 'hugo-tool', title: '准备 Hugo Extended',
      async run(context, io) {
        context.hugo = await command('bash', [path.join(context.root, 'scripts/hugo.sh'), '--resolve'], { ...io, cwd: context.root, env: { ...context.env, SHIUE_HUGO_OFFLINE: context.offline ? '1' : '0' }, capture: true });
        const version = await command(context.hugo, ['version'], { ...io, cwd: context.root, env: context.env, capture: true });
        io.log(version);
        return { version };
      },
    },
    {
      id: 'identity', title: '获取 GitHub 头像与站点图标',
      async run(context, io) {
        const manifest = await prepareIdentity({ root: context.root, offline: context.offline, ...io });
        return { fingerprint: manifest.fingerprint, generatedAt: manifest.generatedAt, assets: identityAssets(manifest).length, offline: context.offline };
      },
    },
    {
      id: 'friends', title: '检测友情链接',
      skip: context => context.offline ? '离线模式，不访问友链' : false,
      run: (context, io) => updateFriendHealth({ root: context.root, ...io }),
    },
    {
      id: 'images', title: '准备缩略图与 BlurHash',
      async run(context, io) {
        const { prepareImages } = await import('../prepare-images.mjs');
        const manifest = await prepareImages(context.root, {
          log: io.log,
          onProgress({ completed, total }) {
            io.signal?.throwIfAborted();
            if (completed % 10 === 0 || completed === total) io.log(`图片进度 ${completed}/${total}`);
          },
        });
        return { images: Object.keys(manifest).length };
      },
    },
    {
      id: 'hugo-build', title: '构建静态站点',
      async run(context, io) {
        await command(context.hugo, ['--minify', '--destination', context.destination, ...context.hugoArgs], {
          ...io, cwd: context.root, env: { ...context.env, SHIUE_IMAGES_READY: '1' },
        });
        return { destination: context.destination };
      },
    },
    {
      id: 'artifacts', title: '检查部署产物',
      async run(context, { log }) {
        for (const file of await readdir(context.destination, { recursive: true })) {
          if (/\.(?:html|xml|json)$/i.test(file) && /\p{Script=Han}/u.test(decodeURIComponent(file))) {
            throw new Error(`部署产物禁止中文路径（含别名页）：${file}`);
          }
        }
        for (const file of ['index.html', '404.html', 'index.xml', 'links/index.html', 'comment-pages.json', 'comment-review/index.html']) {
          const info = await stat(path.join(context.destination, file));
          if (!info.isFile() || !info.size) throw new Error(`部署产物为空：${file}`);
        }
        const friends = JSON.parse(await readFile(path.join(context.root, 'data/friends.json'), 'utf8'));
        for (const friend of friends) {
          if (!/^\/friends\/[a-z0-9.-]+\.(webp|ico)$/.test(friend.image)) throw new Error(`友链图标路径无效：${friend.title}`);
          const icon = await stat(path.join(context.destination, friend.image));
          if (!icon.isFile() || !icon.size) throw new Error(`缺少友链图标：${friend.title}`);
        }
        const identity = await readIdentity(context.root);
        for (const src of [...identityAssets(identity).map(asset => asset.src), 'favicon.ico', 'avatar.jpg']) {
          const icon = await stat(path.join(context.destination, src));
          if (!icon.isFile() || !icon.size) throw new Error(`缺少站点图标：${src}`);
        }
        log(`首页、404、RSS、友链页、站点图标及 ${friends.length} 个友链图标已就绪`);
        return { localIcons: friends.length };
      },
    },
  ];
}
