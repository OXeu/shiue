# 部署流程

`npm run deploy`、`npm run build` 和各平台的 Build Command 统一进入 `scripts/deploy.mjs`（旧入口 `bash scripts/hugo.sh --minify` 亦同）。此流程只负责生成与检查产物，上传和发布由托管平台执行，本地运行不会触发线上发布。平台配置见 [Serverless 部署](serverless.md)。

```text
环境检查 → Hugo 工具准备
        ↓
   GitHub 站点图标
        ↓
  友链检测 → 图片预处理
        ↓
D2 SVG 预渲染与压缩
        ↓
Hugo 构建 → 产物检查 → 耗时汇总 + JSON 报告
```

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `scripts/deploy.mjs` | 参数解析、互斥锁、取消信号、唯一 CLI 入口 |
| `scripts/deploy/steps.mjs` | 声明有序步骤及业务逻辑 |
| `scripts/deploy/pipeline.mjs` | 步骤生命周期、错误边界、计时及报告 |
| `scripts/deploy/reporter.mjs` | 终端展示、进度与耗时汇总 |
| `scripts/deploy/process.mjs` | 子进程输出流、退出码和取消处理 |
| `scripts/deploy/friends.mjs` | 有限并发的友链健康检测、重试和快照 |
| `scripts/deploy/identity.mjs` | 联网拉取 GitHub 头像、生成站点图标 |
| `scripts/prepare-d2.mjs` | D2 图表预渲染与压缩 |
| `scripts/deploy/files.mjs` | JSON 原子写入 |
| `scripts/hugo.sh` | Hugo 版本解析、校验和、工具缓存 |

步骤按注册顺序执行。新增预处理只需在 `deploymentSteps()` 中注册一步：

```js
{
  id: 'custom-preprocess',
  title: '新的预处理',
  skip: context => context.offline ? '离线模式' : false,
  async run(context, { log, warn, signal }) {
    log('进度信息');
    signal?.throwIfAborted();
    return { processed: 10 }; // 写入报告
  },
}
```

每步自动记录开始时间、耗时、状态与警告；失败会停止后续步骤。报告位于 `.cache/deploy/report.json`，不提交到 Git。

## 命令

```bash
npm ci
npm run deploy                                # 完整构建（与 build 相同）
npm run build -- --offline                   # 离线，需已有 Hugo 与图标产物
npm run identity                             # 重新生成站点图标
npm run d2                                   # 预渲染 D2 SVG
npm run d2:watch                             # 监听 D2 代码块变化
npm run dev                                  # 开发服务器
npm run deploy -- --list                     # 列出注册步骤
npm run deploy -- --destination /tmp/out --baseURL https://example.com/blog/
npm run check:deploy                         # 本地回归，不触发真实部署
```

`HUGO_BIN` 可指定 Hugo 二进制；Linux x86_64 未安装时自动下载官方 Extended 发行包并验证 SHA-256，缓存在 `.cache/deploy/hugo/`。

同一工作区不能同时运行两个部署流程。进程被 SIGKILL 或断电后，需确认无运行中构建再删除 `.cache/deploy/run.lock`。

## 图片构建缓存

图片缓存只使用 `$PWD/.cache/xeu-images/`：`images.json` 保存清单，`files/` 保存派生 WebP。Cloudflare Workers Builds 需在 **Settings → Build → Build cache** 启用。

每份唯一内容只解码一次，并行生成 640px 小图与 1600px 中图；原图不改写、不进缓存。命中缓存时直接恢复，不重新压缩；缓存缺失、损坏或配方变更时重新生成。并发默认最多 6 组，可用 `SHIUE_IMAGE_CONCURRENCY` 调整。

构建日志显示「缓存复用 N 张，K 张新生成」；首次构建全量生成，命中缓存后应为 `0 张新生成`。

`node scripts/check-images.mjs` 验证冷/热缓存、跨工作区恢复、改名/更新、损坏清单与旧缓存清理。

## D2 构建缓存

`scripts/prepare-d2.mjs` 扫描 `content/` 中的 D2 代码块，按内容指纹缓存于 `.cache/xeu-d2/`。源码未变时不重新渲染，直接重建清单；语法错误终止构建。缓存与清单缺失时 `npm run build` 自动补齐；绕过统一入口直接执行 Hugo 前，必须先运行 `npm run d2`。

## 友链检测

每次非离线部署重新检测 `data/friends.json` 中的站点：GET 请求、最多 5 次跳转、收到响应头即取消正文、单次最多 8 秒，失败重试一次。2xx 为正常；403/401 显示"访问受限"，429 显示"请求受限"，另区分证书、DNS、超时问题。

结果写入被 Git 忽略的 `data/xeu/friend-health.json`，模板据此分组显示，恢复后自动移回。站点异常只产生警告，不阻断部署。

检测结果反映构建时的访问情况，不是持续监控。开发服务器与 GitHub Actions 构建不访问友链。

## GitHub 头像与站点图标

唯一来源为 `https://avatars.githubusercontent.com/u/36541432`。每次部署重新下载（GitHub 可能返回 Octocat 占位图，下载器按 SHA-256 识别并重试），生成：

| 用途 | 产物 |
| --- | --- |
| favicon | 16 / 32 / 48px 圆角透明 WebP + 兼容 ICO |
| Apple Touch Icon | 180px PNG |
| 应用图标 | 192px WebP |
| 分享图 | 512px PNG（无封面页面的默认值） |
| 页面头像 | 48–512px 响应式 WebP |

产物写入 `static/site-identity/<指纹>/`，兼容地址 `/favicon.ico`、`/avatar.jpg` 一并生成，全部被 Git 忽略。内容指纹地址保证头像更新后浏览器不会命中旧图。

下载或处理失败会终止部署，不会悄悄使用旧头像。仅 `--offline` 允许复用本机已有产物，缺失时报错，需先联网执行 `npm run identity`。

## 每日刷新

`.github/workflows/daily-deploy.yml` 每天 UTC 03:17（北京时间 11:17）向默认分支推送一条空提交，由托管平台 Git 集成触发构建，刷新头像与友链状态。工作流本身不构建站点。

- 手动运行：Actions 页面选择「每日刷新部署」，仅限默认分支。
- 推送使用 `GITHUB_TOKEN`（`contents: write`），无需新增 Secret。
- 与普通提交冲突时自动 rebase 并重试，最多 5 次，不强制推送。
- 配置了 Ignored Build Step 的平台需允许空提交触发构建。

调度可能延迟；公开仓库长期无活动时 Actions 可能被停用，见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-a-workflows#schedule)。

## 评论审批发布

评论和友链共用 `/api/submissions` Serverless Function。流程：绑定内容的 Turnstile 验证 → 邮件审批 → `publish-comment.yml` 验签并提交评论文件 → Git 集成自动构建。评论 CI 不安装依赖、不构建站点、不调用 Deploy Hook。

函数平台与 GitHub 配置同一个 `COMMENTS_SECRET`，程序自动派生各用途密钥。完整配置见 [评论系统](comments.md)。
