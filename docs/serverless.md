# Serverless 部署

项目支持 Vercel Functions、Netlify Functions，以及带 Static Assets 的 Cloudflare Workers。所有入口共用 `server/submissions.js`，提供同源 `POST /api/submissions`；评论、友链、Turnstile 验证、审批签名、邮箱加密与通知重试采用同一实现。

| 平台 | 函数入口 | 部署配置 | 评论白名单 |
| --- | --- | --- | --- |
| Vercel | `api/submissions.js` | `vercel.json` | 打包 `public/comment-pages.json`，由 Node 文件系统读取 |
| Netlify | `netlify/functions/submissions.mjs` | `netlify.toml` | `included_files` 随函数打包，由 Node 文件系统读取 |
| Cloudflare Workers | `cloudflare/worker.js` | `wrangler.jsonc` 仅描述部署结构；业务变量在控制台管理 | 使用当前部署的 `env.ASSETS` 读取静态文件 |

共享模块接收标准 `Request` 并返回 `Response`，平台入口注入 `env`、`deployment` 和 `pages()`。核心模块不读取 `process.env` 或文件系统。Node Crypto 用于保持既有签名和邮箱密文兼容，Cloudflare 启用 `nodejs_compat`；新平台需要支持相同的 Crypto API。对 Turnstile、邮件与 GitHub 的请求使用 `redirect: manual`，拒绝非成功响应，不携带凭据跟随重定向。

## 通用配置

静态站点和 API 应部署在同一域名下，前端无需按平台修改 URL。构建命令为 `npm run deploy`，发布目录为 `public`，Node 版本由 `.node-version` 固定为 24。Hugo 由现有构建脚本准备。

在所选平台的生产函数环境配置 `.env.example` 中的变量。`COMMENTS_SITE_URL` 必须是实际正式站点的 HTTPS 地址，且与 Hugo 的 `baseURL` 一致。需要更改域名时可将构建命令设为 `npm run deploy -- --baseURL https://your-domain.example/`。`COMMENTS_SECRET` 与 GitHub Actions 同名 Secret 保持一致；切换平台时迁移原密钥及旧覆盖项，避免使审批链接或已有邮箱密文失效。密钥配置说明见[评论系统](comments.md)。

Turnstile 在上述所有平台上都可使用，无需 Cloudflare DNS/CDN。在 Cloudflare 创建 Managed 组件并添加正式域名，然后在生产函数环境设置 `TURNSTILE_SITE_KEY`（公开 Site Key）和 `TURNSTILE_SECRET_KEY`（Secret）。两个值均由共享处理器运行时读取，无需构建注入；Secret 不放入 Hugo 配置或 GitHub Actions。升级后旧的 `COMMENTS_POW_DIFFICULTY`、`COMMENTS_POW_SECRET` 可删除。完整配置和迁移说明见[评论系统](comments.md#2-配置-turnstile-与防滥用)。

预览和开发环境不允许提交、发信或发布，不能仅靠 Origin 判断生产环境：

| 平台 | 生产环境识别 |
| --- | --- |
| Vercel | 平台提供的 `VERCEL_ENV=production`；保留现有 Node 单元测试的无平台配置调用方式 |
| Netlify | 平台请求上下文 `context.deploy.context=production`；缺失上下文时拒绝 |
| Cloudflare Workers | 控制台设置 `COMMENTS_ENV=production`，且请求地址的 origin 必须与 `COMMENTS_SITE_URL` 相同；版本预览地址即使继承生产变量也拒绝 |

审核页面的 `no-store`、`no-referrer`、`noindex` 和 CSP 在 Vercel 使用 `vercel.json`，Netlify 与 Cloudflare 使用 Hugo 复制到发布目录的 `static/_headers`。API 响应头由共享处理器统一设置。

## Vercel

继续使用现有 Git 集成和 `vercel.json`，保留已有生产变量，并添加上述 Turnstile 两项配置。`public/comment-pages.json` 保持在函数的 `includeFiles` 中。安装阶段直接执行 `npm ci`；图片缓存只使用项目 `.cache/xeu-images`，平台未恢复该目录时会重新生成。

## Netlify

1. 导入 Git 仓库，使用仓库内 `netlify.toml`：构建命令 `npm run deploy`，发布目录 `public`，函数目录 `netlify/functions`。
2. 在控制台配置生产环境的函数变量，确保作用域包含 Functions。`netlify.toml` 中的构建环境变量不自动提供给函数运行时，不能用它存放这些密钥。[Netlify 环境变量说明](https://docs.netlify.com/build/functions/environment-variables/)
3. 保持 `functions.submissions.included_files`，将构建生成的白名单打包进函数。入口导出的 `config.path` 将函数挂到 `/api/submissions`，不需要额外重写规则。[Netlify 函数配置](https://docs.netlify.com/build/functions/configuration/)

`build.ignore = "exit 1"` 覆盖 Netlify 默认的文件差异检查，确保每日空提交也进入构建流程。[Netlify 忽略构建规则](https://docs.netlify.com/build/configure-builds/ignore-builds/)

Netlify 会按 `.node-version` 选择构建 Node 版本；如曾单独覆盖函数运行时，应使用 Node 22 或更新版本。预览判断使用平台的 deploy context，不依赖可能只在构建时存在的 `CONTEXT` 环境变量。[Netlify Context API](https://docs.netlify.com/build/functions/api/#deploy)

## Cloudflare Workers

如果部署日志出现自动创建 Wrangler 配置及 `[build] Running: npx hugo`，说明平台没有采用仓库配置。自动检测选出的 `npx hugo` 没有运行项目的 Node 构建流程，还遗漏了 API 入口。仓库提供明确的 Workers 配置，阻止自动检测；不需要安装名为 `hugo` 的 npm 包。[Wrangler 自动配置](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

在 Cloudflare 控制台打开 Worker `shiue`，进入 **Settings → Build** 设置：

| 设置 | 值 |
| --- | --- |
| Build command | `npm run build`（原来的 `npm run deploy` 也可，两者都是构建脚本） |
| Deploy command | `npm run deploy:cloudflare`（等价于 `npx wrangler deploy`） |
| Root directory | 仓库根目录 |
| Production branch | 仓库默认分支 |

`wrangler.jsonc` 只固定 Worker 入口、静态资源目录、运行时兼容选项和 `keep_vars: true`，没有 `vars`、`env` 或自定义 `build.command`。业务变量与 Secrets 继续在 **Settings → Variables and Secrets** 管理；Workers 部署保留控制台普通变量，Secrets 也不会因部署而删除。已被过去部署删除的值仍需补回一次。本地 `.env` 不会自动上传。[保留控制台变量](https://developers.cloudflare.com/workers/wrangler/configuration/#top-level-only-keys)

生产 Worker 必须设置 `COMMENTS_ENV=production`、准确的 `COMMENTS_SITE_URL` 和 `.env.example` 中的业务配置。不要只填在 **Build variables** 中：构建环境与运行时环境不同，API 需要运行时变量。`COMMENTS_SECRET`、`RESEND_API_KEY`、`COMMENTS_GITHUB_TOKEN` 及旧密钥覆盖项使用 Secrets。若部署到另一个 Worker，可通过 `--name YOUR_WORKER` 覆盖仓库默认名称 `shiue`。

`/api/*` 总是进入 Worker；`/api/submissions` 接入共享 API，其他 API 路径返回 404。文章、图片和审核页面由 Static Assets 提供，保留 `_headers`，不存在的页面使用 `404.html`。评论白名单通过 `ASSETS` 绑定读取；路由由 `assets.run_worker_first` 固定，不需要额外路由文件。[Workers 静态资源配置](https://developers.cloudflare.com/workers/static-assets/binding/)

本地运行 `npm run build -- --offline`（需已有缓存）后执行 `npm run dev:cloudflare`，本地强制 `COMMENTS_ENV=development`。命令行发布时先运行 `npm run build`，再运行 `npm run deploy:cloudflare`。部署命令不重复构建；不要将 Build command 写成 `npx hugo`。

Workers 版本预览地址即使继承生产变量，也不能写入 API。独立预览 Worker 应设置 `COMMENTS_ENV=preview`，不配置生产密钥；不要将非生产分支部署到生产 Worker。

根目录 Hugo 配置已从 `config.toml` 改名为 `hugo.toml`，构建脚本同步读取新文件。这消除了自动检测器将同一个 `config.toml` 同时识别为 Hugo 和 Zola 的冲突；Hugo 原生支持新文件名。[Hugo 配置文件](https://gohugo.io/configuration/introduction/#configuration-file)

## 发布与验证

各平台都通过 Git 集成跟随仓库默认分支：已审批评论、友链和每日空提交推送后，由所选平台构建发布。生产分支需一致；如配置了按文件差异跳过构建，需允许每日空提交触发部署。只启用实际使用的平台项目，避免同一次推送触发多个生产部署。

```sh
npm run check:functions
npm run check:comments
npm run check:friend-applications
```

适配测试覆盖所有入口的挑战、审核邮件、预览、发布、邮箱密文兼容、缺失白名单，以及伪造生产 Origin 时的预览隔离；额外覆盖 Workers 路由与控制台变量保留配置。Turnstile、邮件与 GitHub 请求全部模拟，不触发真实发布。Hugo 构建和现有浏览器验证继续适用，平台切换不会改变前端协议。
