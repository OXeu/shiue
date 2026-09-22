# Serverless 部署

支持 Vercel Functions、Netlify Functions 与带 Static Assets 的 Cloudflare Workers。所有入口共用 `functions/submissions.js`，提供同源 `POST /api/submissions`。适配代码统一在 [`functions/`](functions/) 目录；Vercel 强制从 `api/` 发现函数，因此保留一个仅几行的桥接入口 `api/submissions.js`。

| 平台 | 函数入口 | 部署配置 | 评论白名单 |
| --- | --- | --- | --- |
| Vercel | `api/submissions.js`（桥接 `functions/`） | `vercel.json` | `public/comment-pages.json` 由 Node 文件系统读取 |
| Netlify | `functions/netlify/submissions.mjs` | `netlify.toml` | `included_files` 随函数打包 |
| Cloudflare Workers | `functions/cloudflare/worker.js` | `wrangler.jsonc`；业务变量在控制台管理 | `env.ASSETS` 读取静态文件 |

共享模块位于 `functions/` 根部（提交处理、评论、友链、运行时适配），接收标准 `Request` / `Response`，不读取 `process.env` 或文件系统；平台入口注入 `env` 与 `pages()`。对 Turnstile、Resend、GitHub 的请求一律 `redirect: manual`，拒绝非成功响应。

## 通用配置

- 静态站点与 API 部署在同一域名，构建命令 `npm run deploy`，发布目录 `public`。
- Node 版本由 `.node-version` 固定；Hugo 由构建脚本准备。
- `COMMENTS_SITE_URL` 须为正式 HTTPS 地址且与 Hugo `baseURL` 一致。
- `COMMENTS_SECRET` 与 GitHub Actions 同名 Secret 保持一致；切换平台时迁移原密钥，避免审批链接与邮箱密文失效。

各平台的生产环境识别方式：

| 平台 | 识别方式 |
| --- | --- |
| Vercel | `VERCEL_ENV=production` |
| Netlify | 请求上下文 `context.deploy.context=production`，缺失时拒绝 |
| Cloudflare | 控制台设 `COMMENTS_ENV=production`，且请求 origin 与 `COMMENTS_SITE_URL` 相同 |

预览与开发环境一律拒绝提交、发信和发布。审核页的 `no-store`、CSP 等响应头在 Vercel 由 `vercel.json` 配置，Netlify 与 Cloudflare 由 `static/_headers` 提供；指纹资源缓存一年并标记 `immutable`，HTML / RSS 按次验证。

## Vercel

导入 Git 仓库即可，`vercel.json` 已配置完整流程。`public/comment-pages.json` 保持在函数的 `includeFiles` 中，图片缓存只使用项目 `.cache/xeu-images`，平台未恢复时自动重新生成。

## Netlify

1. 导入仓库，`netlify.toml` 已定义构建命令、发布目录与函数目录。
2. 在控制台配置生产环境的**函数**变量——`netlify.toml` 的构建变量不自动提供给函数运行时。
3. `included_files` 将白名单打包进函数，`config.path` 已挂载到 `/api/submissions`。

`build.ignore = "exit 1"` 确保 Netlify 不因文件差异跳过每日空提交的构建。

## Cloudflare Workers

若部署日志出现自动创建 Wrangler 配置和 `npx hugo`，说明平台未采用仓库配置。在控制台 **Settings → Build** 设置：

| 设置 | 值 |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:cloudflare` |
| Root directory | 仓库根目录 |
| Production branch | 仓库默认分支 |

`wrangler.jsonc` 只固定入口、静态资源目录与兼容选项，业务变量在 **Settings → Variables and Secrets** 管理（`keep_vars: true` 保证部署不删除控制台变量）。注意：

- 必须设置运行时变量，不要只填在 Build variables 中——构建环境与运行时环境不同。
- `COMMENTS_SECRET`、`RESEND_API_KEY`、`COMMENTS_GITHUB_TOKEN` 使用 Secrets。
- 生产 Worker 需设 `COMMENTS_ENV=production`；版本预览地址即使继承生产变量也会被拒绝。
- 本地运行 `npm run build -- --offline` 后执行 `npm run dev:cloudflare`。
- 根目录 Hugo 配置已改名 `hugo.toml`，避免被同时识别为 Hugo 和 Zola。

## 发布与验证

各平台通过 Git 集成跟随默认分支：评论、友链和每日空提交推送后自动构建。生产分支需一致；只启用实际使用的平台，避免同一次推送触发多个部署。
