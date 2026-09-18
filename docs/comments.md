# 邮件审批 + Git 静态评论

不需要数据库，也不再使用 Twikoo。Vercel Functions 负责提交和审批；Resend 送审核邮件；GitHub Actions 将批准后的评论写入本仓库；Hugo 在构建时生成评论 HTML。

```text
读者提交 → /api/comments-challenge → 浏览器 Worker 计算 PoW
                         ↓ 带证明提交
             /api/comments-submit → Resend → 博主收到审核邮件
                                                ↓
                                 邮件链接打开评论预览（不发布）
                                                ↓ 手动确认
                                   /api/comments-approve
                                                ↓ 签名 workflow_dispatch
                                   publish-comment.yml
                                                ↓
                            独立 JSON → 构建验证 → Git push
                                                ↓
                                   Vercel Deploy Hook
                                                ↓
                                  Hugo 静态 HTML 展示评论
```

## 使用与数据

- 第一版支持文章页的昵称 + 纯文本留言（最多 2,000 字符），评论记录不保存邮箱、IP 或头像，不提供附件、Markdown、嵌套回复或邮件回复通知。评论代码不读取 IP 做限流；基础设施仍可能保留含 IP 的访问日志。
- 已批准评论直接显示在 HTML 中，无 JavaScript 也可阅读；阅读不请求评论 API。不在评论区展示待审内容。
- 提交成功仅表示 Resend 接受了审核邮件，不表示已批准，也不保证邮件已投递至收件箱。审批成功仅表示 GitHub 接受了任务，不表示部署已经完成。
- 不想通过时忽略邮件即可。没有额外的待审数据库，待审内容留在邮件中。审批链接从提交时间起 7 天内有效；过期需重新提交。
- 数据位于 `data/comments/<UUID>.json`，字段只有 `id`、`path`、`name`、`message`、`createdAt`。内容由 Hugo 转义为纯文本，不能执行 HTML。文章路径必须匹配构建生成的 `comment-pages.json` 白名单，文章标题取自白名单而非读者输入。
- 修改/删除已发布评论可通过普通 Git 提交进行，随后部署。删除文件不等于抹除公开 Git 历史。审批链接有效期内重放可能重新添加已删除的文件；需要立即撤销所有未过期链接时轮换 `COMMENTS_APPROVAL_SECRET`。
- 旧 Twikoo 评论没有自动迁移，没有删除旧服务的数据。迁移前需取得导出数据并确认公开范围。

## 1. 配置 Resend

在 Resend 验证发件域名并创建仅允许发送邮件的 API Key。建议为审核邮件关闭点击和打开跟踪，保留原始 URL fragment。发件地址必须属于已验证域名；收件地址由服务端固定，访客不能指定。

在 **Vercel 项目 → Settings → Environment Variables → Production** 设置：

| 变量 | 含义 |
| --- | --- |
| `COMMENTS_SITE_URL` | 正式博客地址，HTTPS、末尾 `/`；例如 `https://blog.lab.xeu.life/`。用于校验 Origin、生成原文/审批链接 |
| `RESEND_API_KEY` | Resend 发送权限密钥 |
| `COMMENTS_EMAIL_FROM` | 已验证发件地址，例如 `Xeu Blog <comments@xeu.life>` |
| `COMMENTS_EMAIL_TO` | 接收审核邮件的本人邮箱，不会打包进前端或评论文件 |
| `COMMENTS_APPROVAL_SECRET` | 至少 32 字符的独立随机密钥，用于邮件审批签名 |
| `COMMENTS_POW_SECRET` | 至少 32 字符的另一把独立随机密钥，仅用于短期 PoW 挑战签名，不可与审批/工作流密钥复用 |
| `COMMENTS_POW_DIFFICULTY` | 可选，默认 `5`；仅接受整数 `4`–`6`，表示 SHA-256 十六进制结果的前导零数量 |
| `COMMENTS_WORKFLOW_SECRET` | 另一把独立随机密钥，用于签名 GitHub 发布参数；同值也要设置到 GitHub Secrets |

可分别运行三次 `openssl rand -hex 32` 生成三把密钥。不要把密钥、数据库连接串或完整审批链接写到公开 issue / 日志 / 聊天中。`.env.example` 只有空值模板；`.env`、`.env.*` 与 `.vercel/` 已被忽略。

## 2. 工作量证明与防滥用

当前版本不依赖 Vercel Firewall 限流规则，不调用限流 SDK，也不占用自定义限流规则配额。无需设置 `COMMENTS_RATE_LIMIT_ID` 或 `COMMENTS_CHALLENGE_RATE_LIMIT_ID`；旧值可移除，代码不再读取它们。只要完成 PoW、邮件和审批相关配置，就能签发挑战、送交审核及确认发布。

仍保留绑定评论内容的短期 PoW、同源校验、JSON 类型/大小限制、文章白名单、隐藏诱捕字段、重复点击保护和邮件幂等。缺少 PoW 密钥、无效证明或审批签名时仍拒绝请求，不会降级放行。Origin 可以被脚本伪造，不能单独当作反机器人机制。

**当前没有应用层请求频率或总量限制。** PoW 提高每条不同评论的计算成本，但不能阻止请求触发 Function，也不是 DDoS/费用硬上限。邮件幂等只减少相同请求的重复邮件，不能阻止有能力持续求解的机器人发送不同评论，也不能避免重放请求消耗接口资源。持有审批链接的人重复确认仍可能重复启动工作流，文件幂等不等于阻止任务排队。

上线后留意 Vercel、Resend 与 GitHub Actions 的用量；限流不再是启用评论的配置前提。此次代码修改不创建、修改或删除控制台已有规则。

预览部署明确拒绝真实发信/发布；本地 Hugo 服务器不运行 Vercel Functions。浏览器测试模拟 API，后端测试模拟邮件/GitHub，不使用真实凭据或发送真实邮件。

### 工作量证明协议

参考 [Anubis 的 SHA-256 验证器（固定版本）](https://github.com/TecharoHQ/anubis/blob/4f3cf13ad158b3ecb5ddf79909dc5c48b3cfa264/lib/challenge/proofofwork/proofofwork.go) 的算法语义，使用 Node Crypto / 浏览器 Web Crypto 独立实现；不引入 Anubis 反向代理、Cookie 通行证或它的源代码依赖。

1. 读者填写昵称、评论并同意公开说明后，前端 POST 同一份评论参数到 `/api/comments-challenge`。服务端校验内容和文章白名单，再签发 32 字节随机挑战与 HMAC-SHA256 令牌，有效期 5 分钟；签发不调用外部服务。
2. 单个 Web Worker 寻找非负十进制整数 `nonce`，使 `hex(SHA256(UTF8(challenge + nonce)))` 以 `difficulty` 个 `0` 开头（拼接没有分隔符）。`5` 是 20 位，不是 5 位或 5 字节；期望约 `16^5 = 1,048,576` 次哈希。每增加一级，期望工作量乘 16，不能保证固定耗时，GPU/专用程序仍可更快求解。
3. 前端向 `/api/comments-submit` 发送原评论和 `proof: { token, nonce }`。服务端校验签名、版本、站点、期限、当前难度及规范化评论摘要，自己计算一次哈希验收；不信任客户端传回的难度/哈希/耗时。失败时不调用 Resend；成功后使用幂等键请求发送审核邮件。
4. 令牌绑定评论编号、文章路径、昵称、正文和提交时间。改变任意这些字段不能复用原证明。挑战令牌的签名用途和密钥与审批签名完全分离，挑战不提供审批能力，也不包含明文评论。
5. 每次失败重试获取新挑战，但未改动的评论沿用编号和时间，因此邮件幂等键不变。无数据库版本**不保证证明单次消费**：相同请求在有效期内可重放，Resend 24 小时幂等窗口用于避免重复邮件，但每次请求仍会进入 Function 并调用邮件 API；不使用不可靠的 Function 进程内集合假装全局防重放。

浏览页面不会请求挑战或启动计算。Worker 只在主动提交后加载，最多计算 90 秒；完成、取消、出错或离开页面均会终止 Worker，失败保留草稿。浏览器不支持 Worker/Web Crypto 时拒绝提交，不降级为无证明请求。验证阶段可取消，进入发信阶段后不显示取消按钮（终止客户端请求无法撤回已发邮件）。修改难度或轮换 `COMMENTS_POW_SECRET` 会使之前签发的挑战失效，不影响已发出的审批邮件。

默认难度 `5` 需要在真实手机和常用浏览器上验收；慢设备可将配置降为 `4`，不要仅凭本机耗时提高到 `6`。如果需要严格一次性令牌或跨区域全局限额，应增加有原子消费/计数能力的共享存储，而不是只提高 PoW 难度。

## 3. 配置 GitHub 发布权限

创建只针对 `OXeu/shiue` 的 fine-grained PAT，权限只需 **Actions: write**（以及默认 Metadata: read）。将它设置为 Vercel 生产变量 `COMMENTS_GITHUB_TOKEN`。它只用于请求 `publish-comment.yml`，不提供给浏览器、邮件或工作流输入。也可替换为生命周期受控的 GitHub App installation token，但当前实现不会自动续签。

继续设置 Vercel 生产变量：

```text
COMMENTS_GITHUB_REPOSITORY=OXeu/shiue
COMMENTS_GITHUB_BRANCH=master
```

仓库默认分支必须与上面的分支一致；工作流仅在默认分支执行。在 **GitHub 仓库 → Settings → Secrets and variables → Actions** 添加：

| Secret | 含义 |
| --- | --- |
| `COMMENTS_WORKFLOW_SECRET` | 与 Vercel 同名变量完全一致 |
| `VERCEL_DEPLOY_HOOK_URL` | 指向本项目生产分支的 Vercel Deploy Hook（与每日刷新可复用同一个） |

发布工作流通过 `GITHUB_TOKEN` 的 `contents: write` 提交评论。仓库规则/分支保护仍然生效，需要允许此机器人提交；若仓库要求所有修改必须走 PR，本版本会安全失败，不会绕过保护。

必须先把工作流文件部署到默认分支，GitHub 才能接受 dispatch。Vercel 的环境变量不会自动同步成 GitHub Secrets，二者要分别设置。提交使用 `GITHUB_TOKEN` 时不能依赖新的 GitHub push 工作流自动执行，因此发布工作流显式运行 `npm run deploy`，成功推送后再调用 Deploy Hook。Hook 被接受只是排队，最终发布结果以 Vercel 为准。

## 审批安全与并发

- 邮件包含签名而非加密的审批凭据，任何持有完整链接的人都能在有效期内批准该条评论，请勿转发。签名验证内容、站点与期限。凭据放在 URL fragment 中，不通过 GET 发给服务器；确认页读取后立即清除地址栏 fragment，不写 localStorage。
- 打开邮件链接只预览，不能直接触发 Action。必须在确认页点击按钮，用同源 POST 批准；GET/邮件链接扫描不会发布。
- 待审签名永远不返回给评论提交者；否则读者会获得自我审批能力。
- Action 参数用另一把密钥、另一种签名用途保护，不能把邮件链接直接当作 workflow 输入绕过确认。Action 从事件 JSON 读取参数，不把评论拼进 shell。
- 一条评论一个 UUID 文件，独占创建，重复审批得到相同文件；同编号不同内容拒绝覆盖。提交时间用于显示，Git 提交记录实际批准发布时间。邮件请求在同内容重试时使用固定幂等键；Resend 的去重窗口为 24 小时。
- 不使用全局 GitHub concurrency 单一 pending 槽位，以免突发审批互相取消。并发推送使用 fetch + rebase + 有界重试，不 force push；独立文件保留其他评论与普通代码提交。
- 邮件标题与 HTML 内容经过转义，API 不返回上游密钥/内部错误，不记录邮件正文或完整审批参数。确认页提供 no-store、no-referrer、noindex 与限制性 CSP。

## 验证与故障处理

```bash
npm run check:comments                 # 无限流配置流程、PoW、签名、篡改、过期、邮件幂等、审批和临时 Git 并发测试
npm run check                         # 包括临时评论的静态渲染、XSS 转义与文章隔离检查
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  SHIUE_TEST_URL=http://127.0.0.1:1313/ node scripts/check-comments.mjs
```

浏览器检查使用真实构建后的 Worker 计算并以 Node Crypto 验证证明，同时覆盖取消、超时、Worker 故障、不支持的浏览器、挑战服务不可用及过期后保留草稿。后端测试覆盖不配置任何限流变量时的完整流程，并确认挑战及预览没有额外外部请求。所有自动测试都不发送真实邮件、不调用 GitHub dispatch、不触发生产部署；Git 测试只操作临时仓库。配置好外部服务并部署后，再手动提交一条留言完成真实验收：浏览器验证 → 收邮件 → 核对内容 → 确认批准 → GitHub Action 成功 → 仓库新增评论文件 → Vercel 部署成功 → 页面出现留言。

- **503**：检查 PoW/邮件/审批配置、`comment-pages.json` 是否随函数打包，以及是否误用 Preview 环境。无需检查或创建限流规则。
- **502 / 未送达**：检查 Resend 发件域名、额度和 GitHub Token 权限。浏览器保留草稿/审批按钮，可重试。
- **PoW 403 / 410**：证明无效或过期，重新点击提交会重新获取挑战。若持续失败，检查是否刚轮换了密钥/难度、混用了不同环境或浏览器拦截了 Worker。不要移除服务端验证来解决。
- **验证超时**：草稿仍保留，可稍后重试或换浏览器；持续发生需用实际设备评估难度，不能无限占用 CPU。
- **审批过期**：让读者重新提交。密钥轮换也会使旧链接失效。
- **Action 失败**：在 Actions 查看失败步骤。构建失败时不推送；分支冲突/权限失败时不强推。Hook 失败时可能已写入 Git，可直接重新运行 Action；文件幂等校验不会重复添加。
- **已排队但未展示**：检查 Vercel 构建、部署分支与域名。仓库里的 `npm run deploy` 本身只构建，不上传；真正发布由 Deploy Hook 启动。

参考：[Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
