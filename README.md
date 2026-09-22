<div align="center">
  <h1>Shiue</h1>
  <p>Xeu 的个人博客。基于 Hugo 与独立主题 Xeu，纯静态产物。</p>
  <p>
    <a href="https://xeu.life/">在线访问</a> ·
    <a href="docs/serverless.md">部署指南</a> ·
    <a href="docs/comments.md">评论系统</a>
  </p>
</div>

## 写作

```bash
npm run post:new
```

交互式脚本，依次填写标题、slug、摘要、分类、标签、封面与草稿状态。除标题外均可回车跳过，也可直接传标题：`npm run post:new -- "我的新文章"`。

生成 `content/post/<slug>/index.md`，默认 `draft: true`。编辑后运行 `npm run dev -- --buildDrafts` 预览，发布时改为 `false` 提交即可。

## 特性

- **D2 图表** — 正文写 `d2` 围栏代码块即可，构建期用 WebAssembly 预渲染浅/深双主题 SVG 内联进 HTML，浏览器零额外请求。支持拖拽、捏合缩放、键盘操作，无 JS 时静态图照常显示。
- **X 帖子引用** — `x` 短代码生成静态引用卡片，构建和浏览均不请求 X 或任何第三方资源。
- **图片流水线** — Sharp 构建期自动生成本地图片的 640px / 1600px 两档 WebP 与 BlurHash 占位，按 `srcset` 按需加载，点击才下载原图。
- **静态评论** — 无数据库。Turnstile 验证 → 邮件审批 → GitHub Action 提交评论 JSON → 自动构建，详见 [评论系统](docs/comments.md)。
- **友链系统** — 一条命令添加友链并自动抓取站点信息与图标，部署时检测各站点健康状态。
- **无 JS 可用** — 文章、评论、导航、分页关闭 JavaScript 后均可阅读；动效遵循系统"减少动态效果"设置。

主题为纯白背景、黑灰文字的极简风格，正文最大宽度 760px，支持浅色 / 深色 / 跟随系统三种外观。Cantarell 字体本地提供，见 `static/fonts/OFL.txt`。

## 部署

支持 Vercel、Netlify 与 Cloudflare Workers（Static Assets）三平台，均可通过 Git 集成自动构建，详见 [Serverless 部署](docs/serverless.md)。

以 Vercel 为例：导入仓库即可，[vercel.json](vercel.json) 已配置好 `npm ci` + `npm run deploy`，输出目录 `public`。[每日刷新工作流](.github/workflows/daily-deploy.yml) 每天 UTC 03:17 推送空提交触发重新构建，保持头像与友链状态最新。

## 本地构建

需要 Node.js 22.12+ 与 [.hugo-version](.hugo-version) 指定版本的 Hugo Extended：

```bash
npm ci
npm run dev     # 预览（不检测友链）
npm run build   # 完整构建，产物在 public/
```

`npm run build` 流程：环境检查 → Hugo 准备 → 获取站点图标 → 友链检测 → 图片处理 → D2 预渲染 → 静态构建 → 产物检查，报告写入 `.cache/deploy/report.json`。离线构建加 `-- --offline`；Linux x86_64 未装 Hugo 时会自动下载并校验官方发行包。

## 验证

```bash
npm run check              # 完整回归：部署流程、评论、友链、图片、构建产物
npm run check:functions    # 各 Serverless 平台入口
```

另有一组基于 Playwright 的浏览器检查（需先另开终端 `npm run dev`）：

```bash
node scripts/check-theme.mjs             # 布局、搜索、主题切换、无 JS 回退
node scripts/check-comments.mjs          # 评论交互
node scripts/check-readability.mjs       # 文字对比度与溢出
```

更多检查脚本见 `scripts/` 目录，统一通过 `PLAYWRIGHT_MODULE` 和 `SHIUE_TEST_URL` 指定环境。

## 文档

[部署流程](docs/deployment.md) · [Serverless 部署](docs/serverless.md) · [评论系统](docs/comments.md) · [友链申请](docs/friend-applications.md)

## 许可证

主题代码采用 MIT License，见 `themes/xeu/LICENSE`。BlurHash 解码器为 MIT 许可，见 `themes/xeu/static/licenses/blurhash.txt`；Cantarell 字体为 SIL OFL，见 `static/fonts/OFL.txt`。
