# Serverless 部署

项目支持 Vercel Functions、Netlify Functions 和 Cloudflare Pages Functions。三个入口共用 `server/submissions.js`，提供同源 `POST /api/submissions`；评论、友链、PoW、审批签名、邮箱加密与通知重试采用同一实现。

| 平台 | 函数入口 | 部署配置 | 评论白名单 |
| --- | --- | --- | --- |
| Vercel | `api/submissions.js` | `vercel.json` | 打包 `public/comment-pages.json`，由 Node 文件系统读取 |
| Netlify | `netlify/functions/submissions.mjs` | `netlify.toml` | `included_files` 随函数打包，由 Node 文件系统读取 |
| Cloudflare Pages | `functions/api/submissions.js` | `wrangler.jsonc` | 使用当前部署的 `env.ASSETS` 读取静态文件 |

共享模块接收标准 `Request` 并返回 `Response`，平台入口注入 `env`、`deployment` 和 `pages()`。核心模块不读取 `process.env` 或文件系统。Node Crypto 用于保持既有签名和邮箱密文兼容，Cloudflare 启用 `nodejs_compat`；新平台需要支持相同的 Crypto API。对邮件与 GitHub 的请求使用 `redirect: manual`，拒绝非成功响应，不携带凭据跟随重定向。

## 通用配置

静态站点和 API 应部署在同一域名下，前端无需按平台修改 URL。构建命令为 `npm run deploy`，发布目录为 `public`，Node 版本由 `.node-version` 固定为 24。Hugo 由现有构建脚本准备。

在所选平台的生产函数环境配置 `.env.example` 中的变量。`COMMENTS_SITE_URL` 必须是实际正式站点的 HTTPS 地址，且与 Hugo 的 `baseURL` 一致。需要更改域名时可将构建命令设为 `npm run deploy -- --baseURL https://your-domain.example/`。`COMMENTS_SECRET` 与 GitHub Actions 同名 Secret 保持一致；切换平台时迁移原密钥及旧覆盖项，避免使审批链接或已有邮箱密文失效。密钥配置说明见[评论系统](comments.md)。

预览和开发环境不允许提交、发信或发布，不能仅靠 Origin 判断生产环境：

| 平台 | 生产环境识别 |
| --- | --- |
| Vercel | 平台提供的 `VERCEL_ENV=production`；保留现有 Node 单元测试的无平台配置调用方式 |
| Netlify | 平台请求上下文 `context.deploy.context=production`；缺失上下文时拒绝 |
| Cloudflare Pages | Wrangler 的 `env.production.vars.COMMENTS_ENV=production`；默认 development、预览 preview，缺失时拒绝 |

审核页面的 `no-store`、`no-referrer`、`noindex` 和 CSP 在 Vercel 使用 `vercel.json`，Netlify 与 Cloudflare 使用 Hugo 复制到发布目录的 `static/_headers`。API 响应头由共享处理器统一设置。

## Vercel

继续使用现有 Git 集成和 `vercel.json`，无需更改已有生产变量。`public/comment-pages.json` 保持在函数的 `includeFiles` 中。安装阶段仍通过 `scripts/vercel-install.mjs` 保留图片缓存。

## Netlify

1. 导入 Git 仓库，使用仓库内 `netlify.toml`：构建命令 `npm run deploy`，发布目录 `public`，函数目录 `netlify/functions`。
2. 在控制台配置生产环境的函数变量，确保作用域包含 Functions。`netlify.toml` 中的构建环境变量不自动提供给函数运行时，不能用它存放这些密钥。[Netlify 环境变量说明](https://docs.netlify.com/build/functions/environment-variables/)
3. 保持 `functions.submissions.included_files`，将构建生成的白名单打包进函数。入口导出的 `config.path` 将函数挂到 `/api/submissions`，不需要额外重写规则。[Netlify 函数配置](https://docs.netlify.com/build/functions/configuration/)

`build.ignore = "exit 1"` 覆盖 Netlify 默认的文件差异检查，确保每日空提交也进入构建流程。[Netlify 忽略构建规则](https://docs.netlify.com/build/configure-builds/ignore-builds/)

Netlify 会按 `.node-version` 选择构建 Node 版本；如曾单独覆盖函数运行时，应使用 Node 22 或更新版本。预览判断使用平台的 deploy context，不依赖可能只在构建时存在的 `CONTEXT` 环境变量。[Netlify Context API](https://docs.netlify.com/build/functions/api/#deploy)

## Cloudflare Pages

1. 创建 Pages Git 集成项目，将 `wrangler.jsonc` 的 `name` 改为自己的 Pages 项目名。选择构建命令 `npm run deploy`，发布目录 `public`，生产分支与 GitHub 默认分支一致。
2. 保留 `compatibility_date`、`nodejs_compat` 和生产/预览的 `COMMENTS_ENV` 配置。Pages 会自动编译仓库根目录的 `functions/`。部署环境覆盖规则见 [Pages Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)。
3. 在 Pages 项目生产环境的 Variables and Secrets 中，将 `.env.example` 的配置添加为 Secrets（选择 Encrypt）。`COMMENTS_SITE_URL` 等非敏感项也可写入 `env.production.vars`；使用 Wrangler 后，同名配置字段以文件为准。密钥只能使用 Secrets，预览环境无需生产密钥。[Pages Secrets 配置](https://developers.cloudflare.com/pages/functions/bindings/#secrets)

白名单通过 `env.ASSETS.fetch()` 读取当前部署的 `comment-pages.json`，不访问公开网络、不依赖可写磁盘；文件缺失或损坏时返回 503。[Pages Functions API](https://developers.cloudflare.com/pages/functions/api-reference/#envassetsfetch)

`static/_routes.json` 只让 `/api/submissions` 进入函数，文章、图片及审核 HTML 直接由静态服务提供。本地可先运行 `npm run build -- --offline`（需已有缓存），再使用 `npx wrangler pages dev public` 预览；默认开发绑定会拒绝写入 API。真实提交只在生产配置中启用。

Pages 会对零文件变化的推送跳过路径筛选并启动构建，因此现有每日空提交工作流可继续使用。[Pages 构建路径规则](https://developers.cloudflare.com/pages/configuration/build-watch-paths/)

## 发布与验证

三个平台都通过 Git 集成跟随仓库默认分支：已审批评论、友链和每日空提交推送后，由所选平台构建发布。生产分支需一致；如配置了按文件差异跳过构建，需允许每日空提交触发部署。只启用实际使用的平台项目，避免同一次推送触发多个生产部署。

```sh
npm run check:functions
npm run check:comments
npm run check:friend-applications
```

适配测试覆盖三个平台的挑战、审核邮件、预览、发布、邮箱密文兼容、缺失白名单，以及伪造生产 Origin 时的预览隔离。外部邮件与 GitHub 请求全部模拟，不触发真实发布。Hugo 构建和现有浏览器验证继续适用，平台切换不会改变前端协议。
