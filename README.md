# 🍧Shiue - Xeu's mini world

基于 Hugo 和定制 Stack 主题的个人博客，支持 Vercel 静态部署。

## 本地构建

安装 [.hugo-version](.hugo-version) 指定版本的 [Hugo Extended](https://gohugo.io/installation/)，在仓库根目录执行：

```bash
hugo --minify
```

产物位于 `public/`。本地预览使用 `hugo server`。主题已在配置中启用，无需额外指定 `--theme`。只有 Extended 版本包含本主题使用的 Sass 编译器。

Linux x86_64 也可执行 `bash scripts/hugo.sh --minify`；脚本下载指定版本的官方 Extended 发行包，校验 SHA-256 后构建，下载目录位于系统临时目录。已安装相同版本时直接复用。

## 构建验证

安装 Node.js 24，执行：

```bash
node scripts/check-build.mjs
```

可通过 `HUGO_BIN` 指定 Hugo 可执行文件。验证覆盖首页、分页、归档、搜索索引、RSS、样式和文章引用的本地图片，产物与缓存写入系统临时目录。

[GitHub Actions](.github/workflows/build.yml) 在推送和拉取请求时使用最新稳定版 Hugo Extended 验证。Linux x86_64 可用同一入口检查新版本：

```bash
SHIUE_HUGO_VERSION=latest HUGO_BIN=./scripts/hugo.sh node scripts/check-build.mjs
```

## Vercel

导入仓库后，[vercel.json](vercel.json) 使用 `scripts/hugo.sh` 和 `.hugo-version` 构建，输出目录为 `public`。升级部署版本时更新 `.hugo-version` 并执行构建验证。部署状态以 Vercel 的构建结果为准。
