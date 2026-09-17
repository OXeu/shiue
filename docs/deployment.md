# 部署流程

`npm run deploy`、`npm run build` 和 Vercel 的 Build Command 统一进入 `scripts/deploy.mjs`。旧入口 `bash scripts/hugo.sh --minify` 也会转入此流程。这里的“部署”负责生成、检查发布产物；上传、域名切换和生产发布仍由 Vercel 执行，本地运行不会触发线上发布。

```text
手动构建 / Git 部署 / 每日 Deploy Hook
                  ↓
       环境检查 → Hugo 工具准备
                  ↓
             GitHub 站点图标
                  ↓
        友链检测 → 图片预处理
                  ↓
         Hugo 构建 → 产物检查
                  ↓
        耗时汇总 + JSON 报告
```

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `scripts/deploy.mjs` | 参数解析、同工作区互斥锁、取消信号、唯一 CLI 入口 |
| `scripts/deploy/steps.mjs` | 声明有序步骤及各步骤业务逻辑 |
| `scripts/deploy/pipeline.mjs` | 步骤生命周期、错误边界、跳过后续步骤、统一计时及报告 |
| `scripts/deploy/reporter.mjs` | 终端展示、TTY 动态进度、无 TTY 的逐行日志、耗时汇总 |
| `scripts/deploy/process.mjs` | 子进程输出流、退出码和取消处理 |
| `scripts/deploy/friends.mjs` | 有限并发的 HTTP 健康检测、重试和状态快照 |
| `scripts/deploy/identity.mjs` | 每次联网拉取 GitHub 头像、生成多尺寸站点图标和响应式头像 |
| `scripts/deploy/files.mjs` | JSON 原子写入 |
| `scripts/hugo.sh` | Hugo 版本解析、官方校验和、工具缓存、底层执行和旧入口兼容 |
| `api/daily-deploy.js` | 经过鉴权的每日构建触发器，不在函数内执行耗时预处理 |

步骤默认顺序执行，依赖关系直接体现在注册顺序中；友链检测内部最多 3 个请求并发，图片处理内部最多 2 张图片并发，避免所有预处理同时争用资源。

新增预处理只需在 `deploymentSteps()` 中注册一步：

```js
{
  id: 'custom-preprocess',
  title: '新的预处理',
  // 可选：返回跳过原因；否则不跳过。
  skip: context => context.offline ? '离线模式' : false,
  async run(context, { log, warn, signal }) {
    log('进度或有用信息');
    signal?.throwIfAborted();
    // warn('可恢复的问题') 记录告警但继续；throw Error(...) 终止流程。
    return { processed: 10 }; // 写入报告，不要返回密钥或整个环境变量。
  },
}
```

每步自动得到开始时间、结束时间、耗时、状态和警告列表。成功、告警、失败、取消、跳过有不同标识；失败会停止后续步骤，同时仍打印已执行步骤的耗时。日志在交互终端有动态运行时间，Vercel 日志和重定向输出采用稳定逐行文本；`NO_COLOR=1` 关闭颜色。

报告位于 `.cache/deploy/report.json`，包含总耗时和各步骤信息；失败时同样写入。计时范围从部署 CLI 启动后的流程开始，不含平台的 `npm ci`、排队、上传和域名切换。报告和缓存不提交到 Git，也不放入公开站点目录。

## 命令

```bash
npm ci
npm run deploy                         # 完整部署构建
npm run build                          # 同一套流程
npm run build -- --offline              # 需已有 Hugo 和图标产物，不访问外网
npm run identity                       # 重新下载 GitHub 头像并生成站点图标
npm run deploy -- --list                # 仅列出注册步骤
npm run deploy -- --help
npm run deploy -- --destination /tmp/xeu-output --baseURL https://example.com/blog/
npm run dev                            # 下载头像、准备图片 + 开发服务器，不检测友链
npm run check:deploy                    # 本地回归，不访问真实友链、不触发真实部署
```

`HUGO_BIN` 可指定与 `.hugo-version` 一致的 Extended 二进制；未安装时，Linux x86_64 自动下载官方发行包并验证 SHA-256。二进制保存在 `.cache/deploy/hugo/<版本>/`，图片继续使用内容哈希缓存。缓存能否跨 Vercel 构建保留取决于平台，流程不能依赖缓存才能正确运行。

同一工作区不能同时运行两个部署流程。正常结束、失败或 Ctrl+C 时释放锁；若进程被 SIGKILL 或机器断电，需确认没有运行中的构建后再删除 `.cache/deploy/run.lock`。不要将该文件提交到 Git。

## 友链检测

每次非离线部署都会重新检测 `data/friends.json` 中的站点，使用 GET、跟随最多 5 次跳转，并在收到响应头后取消正文下载。单次检测最多 8 秒；连接错误、5xx 或 429 最多重试一次。2xx 表示正常；403/401 显示“访问受限”，429 显示“请求受限”，避免把反爬限制描述为站点已经关闭。还区分证书、DNS、超时和重定向问题。

结果原子写入被 Git 忽略的 `data/xeu/friend-health.json`，包含检查时间、状态码、尝试次数和耗时。模板按网址覆盖原始 `health`，恢复可用时清空旧状态，其他名称、描述、图标和顺序不变；没有快照时使用 `data/friends.json` 的初始状态。站点异常只产生警告，不阻断本站部署。若所有站点都没有收到任何 HTTP 响应，则保留已有快照；首次构建无快照时保留初始状态，并明确记录警告。

这里反映的是构建机器在检测时的访问结果，不是持续监控，也不能保证所有地区的访问情况一致。开发服务器和现有 GitHub Actions 构建不主动访问友链；`check:deploy` 的健康检测测试只使用本地测试服务器和模拟响应，暂不接入 CI。

## GitHub 头像与站点图标

唯一来源为 `https://avatars.githubusercontent.com/u/36541432`。每次正常部署都发起新的下载请求，使用 GitHub 标准参数 `v=4&s=512` 和 `no-store` / `no-cache` 设置，不附加随机查询参数，也不依赖上次下载、ETag 或仓库中的头像副本。原始响应只留在内存中，处理为以下构建产物：

| 用途 | 尺寸与格式 |
| --- | --- |
| 浏览器 favicon | 16 / 32 / 48px PNG，同尺寸多帧 ICO |
| Apple Touch Icon | 180px PNG |
| Android 图标 | 192px PNG |
| 无封面页面的默认分享图 | 512px PNG；文章已有封面时仍优先使用封面 |
| 页面头像 | 48 / 80 / 96 / 160 / 192 / 240 / 320 / 512px WebP |

关于页显示 80px 头像，通过 `srcset` / `sizes` 为普通屏、2×、3× 屏选择 80 / 160 / 240px 资源。页头保持纯文本。其他位置可复用 `site-avatar.html` partial，传入已生成的显示尺寸。

处理后的资源写入 `static/site-identity/<内容指纹>/`，清单写入 `data/xeu/identity.json`；兼容地址 `static/favicon.ico` 与 `static/avatar.jpg` 也自动生成。以上文件全部被 Git 忽略，旧固定头像已取消版本跟踪，固定 SVG favicon 已删除。一般图片流水线不会重复处理这些图标。

每次部署仍重新下载，即使图片内容未变；内容改变时资源指纹地址自动变化，避免浏览器继续命中旧头像。GitHub 请求最多 12 秒、失败重试一次、最大响应 5MB，并限制解码像素数。GitHub 可能以 HTTP 200 返回默认 Octocat 占位图；下载器通过已确认的占位图 SHA-256 拒绝该响应，并使用不带尺寸参数的同一用户头像地址（`?v=4`）重试。网络、占位图或图片处理失败会终止部署，不会发布占位图或悄悄使用旧头像。修复前生成的图标清单需要联网重新生成，不能直接离线复用。

仅显式 `--offline` 允许复用本机已生成的完整产物；首次离线运行或产物缺失时给出错误，请先联网执行 `npm run identity`。构建验证可复用已验证的图标；全新检出仓库运行构建验证时会先下载一次。`check:deploy` 的图标测试使用内存生成的测试图片和本地占位图样本，不请求真实 GitHub 头像。

## 每日刷新（Vercel）

静态站点只有重新部署后才会展示新状态，因此每日任务触发的是同一套构建流程，而不是尝试在函数运行时修改静态文件。

`vercel.json` 已配置 `17 3 * * *`：每天 UTC 03:17（北京时间 11:17）调用 `/api/daily-deploy`。调度只针对生产部署；实际触发时间受平台计划和调度精度影响，例如 Hobby 不保证准确到分钟。参见 [Vercel Cron 文档](https://vercel.com/docs/cron-jobs) 和 [使用限制](https://vercel.com/docs/cron-jobs/usage-and-pricing)。

启用前需要在 Vercel 控制台完成一次配置：

1. 在项目 **Settings → Git → Deploy Hooks** 创建指向生产分支的 Hook。
2. 在生产环境变量中设置 `VERCEL_DEPLOY_HOOK_URL` 为该完整地址。它包含部署权限密钥，不要提交、分享或打印。
3. 添加生产环境变量 `CRON_SECRET`，使用至少 32 字符的随机密钥。Vercel 调用定时任务时会自动添加对应的 Authorization 请求头。
4. 部署这些代码和环境变量，在 **Cron Jobs** 中确认任务存在。可手动触发一次，查看函数返回 `202`，再查看新构建的七步日志、最新头像及友链状态。

接口检查请求方法、密钥、生产环境和 Hook 主机；缺少配置会返回 503，错误密钥返回 401，Hook 调用失败返回 502。Hook 被接受只代表任务已排队，最终是否发布成功仍需查看 Vercel 构建记录。接口不会把 Hook 地址或上游错误中的密钥写入日志。参见 [Cron 鉴权](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) 和 [Deploy Hooks](https://vercel.com/docs/deploy-hooks)。

仓库中的配置不会自动创建远端 Hook 或环境变量；完成上述设置并发布之前，每日自动更新尚未启用。若更换托管平台，可由其定时任务每日调用相同部署入口，不需要另写一套预处理流程。

## 评论审批发布

同项目的 `/api/comments-challenge`、`/api/comments-submit` 与 `/api/comments-approve` 使用 Vercel Functions，静态博客仍输出至 `public/`。挑战和提交接口随函数打包 `public/comment-pages.json` 以验证文章；提交前需要完成绑定评论内容、5 分钟有效的 SHA-256 工作量证明；审批页 `/comment-review/` 不被索引。`publish-comment.yml` 验证签名后写入独立评论文件，执行同一 `npm run deploy` 构建流程，安全推送 Git，再调用 Vercel Deploy Hook 发布。它不依赖数据库或 Twikoo。PoW 不能代替函数执行前的边缘限流；独立挑战密钥、两条 SDK 限流规则、外部服务及手动验收步骤见 [评论系统配置](comments.md)。
