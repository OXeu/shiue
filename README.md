# 🍧Shiue - Xeu's mini world

基于 Hugo 和独立 **Xeu** 主题的个人博客，支持 Vercel 静态部署。

## 主题

首页、标签及分类列表、搜索结果共用卡片样式。文章页包含目录、代码高亮与复制、图片放大和按需加载的 Twikoo 评论；归档、友链、关于及 404 页面使用同一套样式。原有 `/p/:slug/`、文章别名、分页和 RSS 路径继续有效。关闭 JavaScript 后，文章、导航及分页仍可使用，列表回退为普通网格。

页面支持渐进增强的跨文档 View Transition，卡片进入视口时错峰淡入，重排采用 FLIP 位移动画。图片预览以正文图片的位置为起点展开，先显示已加载的缩略图，原图解码后淡入；关闭时缩回原位并恢复焦点。动效集中在 `assets/js/motion.js`、`image-preview.js` 和 `assets/css/motion.css`，遵循系统“减少动态效果”设置，缺少动画 API 时直接展示内容。

动画主要使用 `transform` 和 `opacity`，仅在运行期间提示图层提升。瀑布流缓存卡片尺寸，只在容器宽度或卡片实际尺寸变化时重排；滚动只在越过页头阈值时更新样式。BlurHash 仅在接近视口时分帧解码，并复用有限缓存；图片解码完成后释放占位画布，搜索更新时释放旧图片观察器。页头和预览遮罩不使用持续的背景模糊滤镜。

样式令牌集中在 `themes/xeu/assets/css/tokens.css`，布局和文章排版分别在 `layout.css`、`content.css`；交互位于 `assets/js/`。主题使用 Hugo 模板、原生 CSS 与 JavaScript；Node.js 仅用于构建时的图片处理，部署产物仍是静态文件。Cantarell 字体随主题本地提供，许可见 `static/fonts/OFL.txt`。旧头像保留在 `static/avatar.jpg`。

## 图片加载

构建时用 Sharp 自动处理 `static/` 和 `content/` 的本地位图（也识别无扩展名图片），生成 320、640、960、1440px WebP 和 4×3 BlurHash；小图不会放大，GIF/WebP 动图保留动画。产物按图片内容哈希缓存，替换原图时自动生成新地址。

列表最多提供 960px 缩略图，正文最多 1440px，通过 `srcset`、`sizes` 按显示尺寸和像素密度选择；默认懒加载。图片加载前由浏览器本地解码 BlurHash 占位，失败时保留占位。点击正文图片才加载原图。首页、分类、标签和搜索使用同一套图片数据。外部图片和 SVG 保留原地址；需要缩略图时可将外部图片保存为本地资源。

`data/xeu/images.json` 与 `static/xeu-images/` 是自动生成并被 Git 忽略的文件。更新图片后执行 `npm run images`；预览时可另开终端运行 `npm run images:watch` 自动更新。BlurHash 解码器采用 MIT 许可，见 `themes/xeu/static/licenses/blurhash.txt`。

## 本地构建

安装 Node.js 22 或更新版本，以及 [.hugo-version](.hugo-version) 指定版本的 [Hugo Extended](https://gohugo.io/installation/)，在仓库根目录执行：

```bash
npm ci
npm run build
```

产物位于 `public/`。本地预览使用 `npm run dev`。这两个入口都会先准备图片；也可先执行 `npm run images`，再直接运行 `hugo --minify` 或 `hugo server`。主题已在配置中启用，无需额外指定 `--theme`。

Linux x86_64 也可执行 `bash scripts/hugo.sh --minify`；脚本下载指定版本的官方 Extended 发行包，校验 SHA-256 后构建，下载目录位于系统临时目录。已安装相同版本时直接复用。

## 构建验证

安装 Node.js 24，执行：

```bash
npm ci
npm run check
```

可通过 `HUGO_BIN` 指定 Hugo 可执行文件。验证覆盖图片生成与缓存、BlurHash 有效性、缩略图尺寸、首页、分页、归档、标签、友链、搜索索引、RSS、纯文本页头、代码块，以及所有页面的本地链接、脚本、字体和图片。测试构建产物写入系统临时目录，图片缓存写入上述 Git 忽略目录。设置 `SHIUE_TEST_BASE_URL=https://example.org/blog/` 可验证子目录部署。

[GitHub Actions](.github/workflows/build.yml) 在推送和拉取请求时使用最新稳定版 Hugo Extended 验证。Linux x86_64 可用同一入口检查新版本：

```bash
SHIUE_HUGO_VERSION=latest HUGO_BIN=./scripts/hugo.sh node scripts/check-build.mjs
```

浏览器回归检查使用 Playwright。先在另一个终端运行 `npm run dev -- --disableLiveReload`，在已安装 Playwright 与 Chromium 的环境中执行 `node scripts/check-theme.mjs`。可用 `PLAYWRIGHT_MODULE` 指向现有 Playwright 的 `index.mjs`，用 `SHIUE_TEST_URL` 指定预览地址。检查覆盖八档屏宽下的四列上限、卡片重叠与溢出、BlurHash 慢速加载占位、缩略图网络请求、原图按需加载、搜索和失败重试、分页、主题切换、代码复制、目录背景、相邻文章对齐及无 JavaScript 回退；截图写入系统临时目录。

`node scripts/check-motion.mjs` 使用相同环境变量，检查图片 Hero 动画、慢速或失败原图、快速开关、键盘焦点、滚动锁定、手机尺寸、动态修改减少动效偏好、动画 API 降级和返回导航，并记录一次开合过程的帧间隔采样。帧间隔受设备与浏览器运行环境影响，不能视为所有设备上的帧率保证。

## Vercel

导入仓库后，[vercel.json](vercel.json) 先执行 `npm ci`，再使用 `scripts/hugo.sh` 生成图片并按 `.hugo-version` 构建，输出目录为 `public`。升级部署版本时更新 `.hugo-version` 并执行构建验证。部署状态以 Vercel 的构建结果为准。
