# 部署流程

`npm run deploy`、`npm run build` 和各平台的 Build Command 统一进入 `scripts/deploy.mjs`。旧入口 `bash scripts/hugo.sh --minify` 也会转入此流程。这里的“部署”负责生成、检查发布产物；上传、域名切换和生产发布仍由所选托管平台执行，本地运行不会触发线上发布。 平台配置见 [Serverless 部署](serverless.md)。

```text
手动构建 / Git 部署（含每日空提交）
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
| `scripts/vercel-install.mjs` | Vercel 安装依赖时保留图片构建缓存，再执行 `npm ci` |
| `.github/workflows/daily-deploy.yml` | 每天向默认分支推送空提交，由 托管平台的 Git 集成触发构建 |

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

`HUGO_BIN` 可指定与 `.hugo-version` 一致的 Extended 二进制；未安装时，Linux x86_64 自动下载官方发行包并验证 SHA-256。二进制保存在 `.cache/deploy/hugo/<版本>/`，图片使用下述内容哈希缓存。没有缓存时仍能正常完成构建。

同一工作区不能同时运行两个部署流程。正常结束、失败或 Ctrl+C 时释放锁；若进程被 SIGKILL 或机器断电，需确认没有运行中的构建后再删除 `.cache/deploy/run.lock`。不要将该文件提交到 Git。

## 图片构建缓存

项目的 `framework: null` 使用 Vercel 的 Other 构建流程。[Vercel 构建器默认缓存规则](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/build-utils/src/default-cache-path-glob.ts)包含 `node_modules/**`，因此图片缓存放在 `node_modules/.cache/xeu-images/`：`images.json` 保存尺寸、内容指纹、BlurHash 和响应式清单，`files/` 保存 WebP 缩略图。单独放在 `static/`、`data/` 或普通 `.cache/` 下不能依靠这条规则跨构建保留。

`vercel.json` 的 Install Command 使用 `node scripts/vercel-install.mjs`。脚本先把图片缓存移动到 `.cache/deploy/` 下的临时目录，执行原有 `npm ci` 后再放回，避免 npm 清空 `node_modules` 时删除缓存；安装失败也尝试恢复，并仍以失败状态退出。无需新增依赖或环境变量。如果控制台曾覆盖 Install Command，应与仓库配置保持一致。

图片预处理逐张计算原图内容与处理配置的指纹。命中完整清单与缩略图时直接恢复到 `data/xeu/images.json` 和 `static/xeu-images/`，不重新压缩或计算 BlurHash；原图重命名也可按内容复用。新增图片、内容变更、处理配置变化或缓存不完整时补算，损坏的 JSON 清单按未命中处理。保存缓存时移除不再被当前图片引用的旧缩略图，避免长期累积。

构建日志会显示“缓存复用 N 张（从构建缓存恢复 M 张），K 张新生成缩略图与 BlurHash”。第一次部署用于填充缓存，后续缓存可用且图片未变时应显示 `0 张新生成`。缓存被清除、过期或手动选择不使用缓存时会重新生成。本地普通 `npm ci` 可能清除缓存副本，但已有发布产物仍可复用并重新填充缓存。

`node scripts/check-images.mjs` 验证冷/热缓存、只携带构建缓存的新工作区、实际 `npm ci` 后恢复、安装失败、图片改名/更新、缺失文件、无效清单和旧缓存清理。

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

## 每日刷新（GitHub Actions）

`.github/workflows/daily-deploy.yml` 使用 `17 3 * * *`，每天 UTC 03:17（北京时间 11:17）向仓库默认分支推送一条 `chore: daily deployment refresh` 空提交。托管平台的 Git 集成收到推送后执行同一套 `npm run deploy`，更新头像和友链状态；工作流不修改文件，也不在 Actions 中构建站点。参见 [Vercel Git 自动部署](https://vercel.com/docs/git/vercel-for-github#a-deployment-for-each-push)。

定时任务需工作流位于默认分支且 GitHub Actions 已启用；也可在 Actions 中选择「每日刷新部署」手动运行。手动执行同样只允许默认分支。调度可能延迟，公开仓库长期无活动时可能被停用，规则见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

推送使用 GitHub 自动提供的 `GITHUB_TOKEN`，工作流声明 `contents: write`，无需新增 Secret。默认分支的规则需允许机器人提交；托管平台的生产分支 应与默认分支一致，并启用 Git 自动部署。如果配置了按文件差异跳过构建的 Ignored Build Step，需要允许这类空提交触发构建。

工作流串行执行每日刷新；与普通提交发生推送竞争时，拉取最新分支、保留空提交进行 rebase，最多推送 5 次，不强制推送。`GITHUB_TOKEN` 的推送不会递归触发仓库的 `push` 工作流，部署由 托管平台的 Git 集成负责，参见 [GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。Actions 成功表示空提交已推送，最终发布结果以托管平台 为准。

旧 `/api/daily-deploy`、Vercel Cron 配置及 `.env.example` 中的 `CRON_SECRET`、`VERCEL_DEPLOY_HOOK_URL` 已移除。部署新配置后，若这些环境变量和 Deploy Hook 没有其他用途，可从控制台删除；仓库修改不会代为删除远端配置。

## 评论审批发布

同项目的评论和友链共用 `/api/submissions` Serverless Function，通过 JSON 的 `type` 与 `action` 区分内容和操作，静态博客仍输出至 `public/`。各平台通过随函数打包的文件或静态资源绑定读取 `comment-pages.json` 以验证评论文章，友链请求不读取文章白名单；提交前需要完成绑定内容、5 分钟有效且单次使用的 Turnstile 验证；审批页 `/comment-review/`、`/friend-review/` 不被索引。`publish-comment.yml` 只验证签名、写入独立评论文件并提交推送，由 托管平台的 Git 集成自动构建部署；不安装 npm 依赖、不在评论 CI 中构建，也不调用 Deploy Hook。函数平台与 GitHub 配置同一个 `COMMENTS_SECRET`，程序自动派生审批、发布和邮箱加密密钥；函数平台另外配置 Turnstile 的 Site Key 和 Secret Key，GitHub 无需部署凭据；每日空提交工作流也无需部署凭据。它不依赖数据库、Twikoo 或 Vercel 限流规则；当前不限制请求频率，Turnstile 不能保证调用量/费用上限。主密钥、外部服务及手动验收步骤见 [评论系统配置](comments.md)。
