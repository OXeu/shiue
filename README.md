# 🍧Shiue - Xeu's mini world

基于 Hugo 和独立 **Xeu** 主题的个人博客，支持 Vercel 静态部署。

## 主题

主题位于 `themes/xeu/`，已移除 Stack。设计参考 Rin 的 compact header、Cantarell 字体、粉色点缀、渐变背景与明暗配色；页头只保留站点名和文字导航。文章卡片参考 Peace RSS 阅读器：16:10 封面、细边框、小圆角、紧凑摘要。瀑布流按文章时间顺序填入当前最短列，随可用宽度显示一至三列，图片、字体和容器变化时自动重排。

首页、标签及分类列表、搜索结果共用卡片样式。文章页包含目录、代码高亮与复制、图片放大和按需加载的 Twikoo 评论；归档、友链、关于及 404 页面使用同一套样式。原有 `/p/:slug/`、文章别名、分页和 RSS 路径继续有效。关闭 JavaScript 后，文章、导航及分页仍可使用，列表回退为普通网格。

样式令牌集中在 `themes/xeu/assets/css/tokens.css`，布局和文章排版分别在 `layout.css`、`content.css`；交互位于 `assets/js/`。主题使用 Hugo 模板、原生 CSS 与 JavaScript，无 Node 运行时或 Sass 依赖。Cantarell 字体随主题本地提供，许可见 `static/fonts/OFL.txt`。旧头像保留在 `static/avatar.jpg`。

## 本地构建

安装 [.hugo-version](.hugo-version) 指定版本的 [Hugo Extended](https://gohugo.io/installation/)，在仓库根目录执行：

```bash
hugo --minify
```

产物位于 `public/`。本地预览使用 `hugo server`。主题已在配置中启用，无需额外指定 `--theme`。新主题不依赖 Extended 专属功能，部署脚本继续统一使用官方 Extended 发行包。

Linux x86_64 也可执行 `bash scripts/hugo.sh --minify`；脚本下载指定版本的官方 Extended 发行包，校验 SHA-256 后构建，下载目录位于系统临时目录。已安装相同版本时直接复用。

## 构建验证

安装 Node.js 24，执行：

```bash
node scripts/check-build.mjs
```

可通过 `HUGO_BIN` 指定 Hugo 可执行文件。验证覆盖首页、分页、归档、标签、友链、搜索索引、RSS、纯文本页头、代码块，以及所有页面的本地链接、脚本、字体和图片，产物与缓存写入系统临时目录。设置 `SHIUE_TEST_BASE_URL=https://example.org/blog/` 可验证子目录部署。

[GitHub Actions](.github/workflows/build.yml) 在推送和拉取请求时使用最新稳定版 Hugo Extended 验证。Linux x86_64 可用同一入口检查新版本：

```bash
SHIUE_HUGO_VERSION=latest HUGO_BIN=./scripts/hugo.sh node scripts/check-build.mjs
```

浏览器回归检查使用 Playwright。先在另一个终端运行 `hugo server --disableLiveReload`，在已安装 Playwright 与 Chromium 的环境中执行 `node scripts/check-theme.mjs`。可用 `PLAYWRIGHT_MODULE` 指向现有 Playwright 的 `index.mjs`，用 `SHIUE_TEST_URL` 指定预览地址。检查覆盖六档屏宽下的卡片重叠与溢出、搜索和失败重试、分页、主题切换、代码复制、图片预览、目录及无 JavaScript 回退；截图写入系统临时目录。

## Vercel

导入仓库后，[vercel.json](vercel.json) 使用 `scripts/hugo.sh` 和 `.hugo-version` 构建，输出目录为 `public`。升级部署版本时更新 `.hugo-version` 并执行构建验证。部署状态以 Vercel 的构建结果为准。
