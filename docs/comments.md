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
                            验签 → 独立 JSON → commit + push
                                                ↓
                               Vercel Git 集成自动构建部署
                                                ↓
                                  Hugo 静态 HTML 展示评论
```

## 使用与数据

- 支持文章页的昵称 + 纯文本留言（最多 2,000 字符）、选填邮箱及多层嵌套回复，每条留言或回复都可继续被回复。填写邮箱即同意接收该条留言的审核通过和直接回复通知；留空仍可正常提交。不保存 IP 或头像，不提供附件或 Markdown。评论代码不读取 IP 做限流；基础设施仍可能保留含 IP 的访问日志。
- 已批准评论直接显示在 HTML 中，无 JavaScript 也可阅读；阅读不请求评论 API。不在评论区展示待审内容。
- 提交成功仅表示 Resend 接受了审核邮件，不表示已批准，也不保证邮件已投递至收件箱。审批成功仅表示 GitHub 接受了任务，不表示部署已经完成。
- 不想通过时忽略邮件即可。没有额外的待审数据库，待审内容留在邮件中。审批链接从提交时间起 7 天内有效；过期需重新提交。
- 数据位于各文章目录的 `content/post/<文章目录>/comments/<UUID>.json`，基础字段为 `id`、`path`、`name`、`message`、`createdAt`；回复另有 `parentId`，指向直接父留言的 UUID，顶层留言省略该字段。Hugo 从文章资源读取留言，按父子关系静态渲染，同级按提交时间排序，正文和昵称转义为纯文本。
- 选填邮箱经格式校验后绑定 PoW 和审批签名。明文只用于服务端处理及私有审核凭据，发布时使用 AES-256-GCM 和随机 nonce 加密，附加认证数据绑定留言编号与文章路径。公开留言文件只保存 `emailEncrypted` 和带密钥的 `emailHash`；后者用于判定重复审批，不能据此直接枚举邮箱。GitHub Action 的发布脚本不解密邮箱，并拒绝写入明文 `email` 字段。静态页面、RSS 和搜索索引不展示邮箱，`comment-pages.json` 只携带供审批函数使用的邮箱密文。
- `comment-pages.json` 白名单包含文章 URL、标题、源目录和已发布留言编号。提交与审批只接受同一文章下的已发布父留言；PoW 和审批签名都绑定 `parentId`。发布目录由白名单确定并签名，不能由访客指定，也不依赖 URL 与文章文件夹同名。Action 会再次核对实际文章、父留言和循环引用。
- 编辑面板默认隐藏，点击标题栏留言数量后的「评论」或昵称、时间行右侧的「回复」文本链接，在按钮旁打开 popover 并聚焦输入框。点击外部、关闭按钮或 Escape 可收起；键盘关闭后焦点返回触发按钮。小屏下限制面板宽高并允许内部滚动，标题与关闭按钮始终可见。
- 草稿按文章路径及直接回复对象分别保存在浏览器 localStorage，包括昵称、选填邮箱、正文、公开同意状态及失败重试编号；关闭、切换对象、刷新和离开后返回均可恢复。提交失败保留草稿，成功只清除当前对象的草稿；点击标题栏「评论」可恢复独立留言草稿。存储不可用时保留本页内存草稿并提示无法跨刷新保存。
- 评论时间按浏览器本地时区显示。未满 72 小时的留言显示「刚刚」「N 分钟前」「N 小时前」「N 天前」，点击或按 Enter / Space 可往返切换绝对时间；满 72 小时后固定显示绝对时间。页面停留期间定期更新时间；无 JavaScript 时显示带时区标识的静态时间。
- 回复层级不设业务上限，深层回复限制视觉缩进以适配手机。父留言删除后已有回复仍会展示，并标明原留言已删除；新回复的直接父留言必须存在。
- 原 `data/comments/` 只有占位文件，本次已移除，没有存量留言需要搬迁。旧版已发出的有效审批邮件仍可确认，审批时会按当前白名单选择新的文章目录；升级前已签发的工作流参数缺少文章目录，需从原审批邮件重新确认。
- 修改/删除已发布评论可通过普通 Git 提交进行，随后部署。删除文件不等于抹除公开 Git 历史。审批链接有效期内重放可能重新添加已删除的文件；如需单独撤销未过期审批，可设置或轮换兼容覆盖项 `COMMENTS_APPROVAL_SECRET`，不改动邮箱加密密钥。
- 已从 `legacy.xeu.life` 的 Rin 公开接口恢复 105 条历史评论：原有 137 条中合并 11 条重复提交、过滤 21 条测试/无意义/纯引流留言，详见 [旧站评论恢复](legacy-comments-migration.md)。来源编号保存在每条评论的 `legacy` 字段中。不导入邮箱等非展示资料，也不修改旧服务数据；更早的 Twikoo 数据库不在此次范围内。

## 1. 配置 Resend

在 Resend 验证发件域名并创建仅允许发送邮件的 API Key。建议为审核邮件关闭点击和打开跟踪，保留原始 URL fragment。发件地址必须属于已验证域名；审核邮件收件人由服务端固定，读者通知收件人只能取自已签名的留言邮箱或已发布父留言的邮箱密文。

在 **Vercel 项目 → Settings → Environment Variables → Production** 设置：

| 变量 | 含义 |
| --- | --- |
| `COMMENTS_SITE_URL` | 正式博客地址，HTTPS、末尾 `/`；例如 `https://blog.lab.xeu.life/`。用于校验 Origin、生成原文/审批链接 |
| `RESEND_API_KEY` | Resend 发送权限密钥 |
| `COMMENTS_EMAIL_FROM` | 已验证发件地址，例如 `Xeu Blog <comments@xeu.life>` |
| `COMMENTS_EMAIL_TO` | 接收审核邮件的本人邮箱，不会打包进前端或评论文件 |
| `COMMENTS_SECRET` | 唯一需要生成的随机主密钥，至少 32 字符；Vercel 与 GitHub 同名 Secret 设置相同值，程序自动派生各用途密钥 |
| `COMMENTS_POW_DIFFICULTY` | 可选，默认 `4`；仅接受整数 `4`–`6`，表示 SHA-256 十六进制结果的前导零数量。已有生产配置若为 `5` / `6`，需改成 `4` 或移除覆盖并重新部署 |

只需运行一次 `openssl rand -hex 32`，将输出分别填入 Vercel 和 GitHub 的 `COMMENTS_SECRET`。代码使用 HKDF-SHA256 按 PoW、审批、发布、邮箱四种用途派生不同密钥，留言和友链共用这一配置。无需手动生成或填写派生密钥。Vercel 与 GitHub 都保存主密钥；不要把它提交到仓库或输出到日志。`.env.example` 只有空值模板；`.env`、`.env.*` 与 `.vercel/` 已被忽略。

旧配置继续兼容：非空的 `COMMENTS_APPROVAL_SECRET`、`COMMENTS_POW_SECRET`、`COMMENTS_WORKFLOW_SECRET`、`COMMENTS_EMAIL_SECRET` 优先覆盖相应用途，直接升级代码不需要改动已有变量。新安装只填 `COMMENTS_SECRET`。删除旧覆盖项才会切换到该用途的派生密钥，也会使依赖原密钥的未过期凭据失效；发布密钥的覆盖项须在 Vercel 与 GitHub 保持一致。已有邮箱密文则应保留原 `COMMENTS_EMAIL_SECRET`，直到完成重加密迁移。主密钥需备份，不能通过直接删除旧邮箱密钥或更换主密钥来迁移既有密文。

### 读者通知

- 审批 Vercel Function 先成功发起 GitHub `workflow_dispatch`，随后等待 Resend 接受通知邮件再返回，不使用返回响应后可能被中断的后台发送。GitHub 拒绝任务或仅预览时不发送读者通知。通知不等待 Action、Git 推送或部署完成，文案明确为“已通过审核，正在发布”。
- 新留言作者填写了邮箱，就发送审核通过通知；该留言是回复且直接父留言保存了邮箱，就向父留言作者发送回复通知。不会通知所有祖先，也不会在未审批时通知。两种通知收件人分别发送，不互相暴露邮箱；自回复且邮箱相同时仅发送审核通过通知。
- 发送失败不撤销已接受的发布任务。审核页显示失败提示及“重试发送通知”，使用单独签名的重试凭据，仅重试失败的通知，不再次启动 GitHub Action。重试凭据只留在当前审核页内存中，最多 24 小时且不超过原审批有效期；刷新后需重新打开审核邮件。
- 每种通知使用固定幂等键，避免超时后立即重试造成重复发送。[Resend 的去重窗口为 24 小时](https://resend.com/docs/dashboard/emails/idempotency-keys)；无数据库模式不承诺跨窗口永久去重，超过窗口重新审批可能再次发信。Resend 接受不等于收件箱投递成功。
- 停止某条已发布留言的后续回复通知，可从其 JSON 删除 `emailEncrypted` 和 `emailHash` 并部署。密文仍可能留在公开 Git 历史中；已发出的审核凭据或通知重试凭据在有效期内仍可重放。

## 2. 工作量证明与防滥用

当前版本不依赖 Vercel Firewall 限流规则，不调用限流 SDK，也不占用自定义限流规则配额。无需设置 `COMMENTS_RATE_LIMIT_ID` 或 `COMMENTS_CHALLENGE_RATE_LIMIT_ID`；旧值可移除，代码不再读取它们。只要完成 PoW、邮件和审批相关配置，就能签发挑战、送交审核及确认发布。

仍保留绑定评论内容的短期 PoW、同源校验、JSON 类型/大小限制、文章白名单、隐藏诱捕字段、重复点击保护和邮件幂等。缺少 PoW 密钥、无效证明或审批签名时仍拒绝请求，不会降级放行。Origin 可以被脚本伪造，不能单独当作反机器人机制。

**当前没有应用层请求频率或总量限制。** PoW 提高每条不同评论的计算成本，但不能阻止请求触发 Function，也不是 DDoS/费用硬上限。邮件幂等只减少相同请求的重复邮件，不能阻止有能力持续求解的机器人发送不同评论，也不能避免重放请求消耗接口资源。持有审批链接的人重复确认仍可能重复启动工作流，文件幂等不等于阻止任务排队。

上线后留意 Vercel、Resend 与 GitHub Actions 的用量；限流不再是启用评论的配置前提。此次代码修改不创建、修改或删除控制台已有规则。

预览部署明确拒绝真实发信/发布；本地 Hugo 服务器不运行 Vercel Functions。浏览器测试模拟 API，后端测试模拟邮件/GitHub，不使用真实凭据或发送真实邮件。

### 工作量证明协议

参考 [Anubis 的 SHA-256 验证器（固定版本）](https://github.com/TecharoHQ/anubis/blob/4f3cf13ad158b3ecb5ddf79909dc5c48b3cfa264/lib/challenge/proofofwork/proofofwork.go) 的算法语义，使用 Node Crypto / 浏览器 Web Crypto 独立实现；不引入 Anubis 反向代理、Cookie 通行证或它的源代码依赖。

1. 读者填写昵称、评论并同意公开说明后，前端 POST 同一份评论参数到 `/api/comments-challenge`。服务端校验内容和文章白名单，再签发 32 字节随机挑战与 HMAC-SHA256 令牌，有效期 5 分钟；签发不调用外部服务。
2. 单个 Web Worker 寻找非负十进制整数 `nonce`，使 `hex(SHA256(UTF8(challenge + nonce)))` 以 `difficulty` 个 `0` 开头（拼接没有分隔符）。默认 `4` 是 16 位，期望约 `16^4 = 65,536` 次哈希；此前 `5` 是 20 位，期望约 `1,048,576` 次哈希。默认工作量降至此前的 1/16。每增加一级，期望工作量乘 16，不能保证固定耗时，GPU/专用程序仍可更快求解。
3. 前端向 `/api/comments-submit` 发送原评论和 `proof: { token, nonce }`。服务端校验签名、版本、站点、期限、当前难度及规范化评论摘要，自己计算一次哈希验收；不信任客户端传回的难度/哈希/耗时。失败时不调用 Resend；成功后使用幂等键请求发送审核邮件。
4. 令牌绑定评论编号、文章路径、昵称、正文、提交时间、回复父编号及选填邮箱（如有）。改变任意这些字段不能复用原证明。挑战和审批使用不同的派生密钥及签名用途，挑战不提供审批能力，也不包含明文评论或邮箱。
5. 每次失败重试获取新挑战，但未改动的评论沿用编号和时间，因此邮件幂等键不变。无数据库版本**不保证证明单次消费**：相同请求在有效期内可重放，Resend 24 小时幂等窗口用于避免重复邮件，但每次请求仍会进入 Function 并调用邮件 API；不使用不可靠的 Function 进程内集合假装全局防重放。

浏览页面不会请求挑战或启动计算。Worker 只在主动提交后加载，最多计算 90 秒；完成、取消、出错或离开页面均会终止 Worker，失败保留草稿。浏览器不支持 Worker/Web Crypto 时拒绝提交，不降级为无证明请求。评论的验证、送交审核和提交成功覆盖整个 popover 显示状态，覆盖期间底层表单不可交互；验证阶段可取消并返回草稿，进入发信阶段后不显示取消按钮（终止客户端请求无法撤回已发邮件）。成功后点击「完成」关闭面板；关闭及重开验证面板不会丢失草稿或重启计算。修改难度或轮换 `COMMENTS_POW_SECRET` 会使之前签发的挑战失效，不影响已发出的审批邮件。

默认难度调整为 `4`，以改善手机端等待约 80 秒的反馈；在计算速度相同的条件下，期望耗时是难度 `5` 的 1/16。移动端 5–15 秒是体验目标，仍需真实手机和常用浏览器验收；设备性能及随机搜索会导致单次耗时波动，不人为等待以凑足 5 秒，也不能保证 15 秒内一定找到解。保留 90 秒上限防止持续占用 CPU。不要仅凭本机耗时提高到 `6`。该配置也由友链申请复用。如果需要严格一次性令牌或跨区域全局限额，应增加有原子消费/计数能力的共享存储，而不是只提高 PoW 难度。

## 3. 配置 GitHub 发布权限

创建只针对 `OXeu/shiue` 的 fine-grained PAT，权限只需 **Actions: write**（以及默认 Metadata: read）。将它设置为 Vercel 生产变量 `COMMENTS_GITHUB_TOKEN`。它只用于请求 `publish-comment.yml`，不提供给浏览器、邮件或工作流输入。也可替换为生命周期受控的 GitHub App installation token，但当前实现不会自动续签。

继续设置 Vercel 生产变量：

```text
COMMENTS_GITHUB_REPOSITORY=OXeu/shiue
COMMENTS_GITHUB_BRANCH=master
```

仓库默认分支必须与上面的分支一致；工作流仅在默认分支执行。在 **GitHub 仓库 → Settings → Secrets and variables → Actions** 只需手动添加一个 Repository secret：

| Secret | 含义 |
| --- | --- |
| `COMMENTS_SECRET` | 与 Vercel 同名变量完全一致，只需复制同一主密钥 |

发布工作流通过 GitHub 自动提供的 `GITHUB_TOKEN`（`contents: write`）提交评论，无需另配推送 Token。`COMMENT_FILE` 来自验签步骤输出，`COMMENTS_BRANCH` 来自仓库默认分支，其他 `GITHUB_*` 上下文由 Actions 提供；这些都不需要手动配置。仓库规则/分支保护仍然生效，需要允许此机器人提交；若仓库要求所有修改必须走 PR，本版本会安全失败，不会绕过保护。

必须先把工作流文件部署到默认分支，GitHub 才能接受 dispatch。Vercel 的环境变量不会自动同步成 GitHub Secrets，`COMMENTS_SECRET` 两边要分别设置成相同值。工作流保留对旧 `COMMENTS_WORKFLOW_SECRET` 的兼容，新安装无需配置它。评论工作流只做 checkout、准备 Node、验签写文件、提交推送；两个发布脚本只用 Node 内置模块，不安装 npm 依赖，不运行测试或 Hugo 构建，也不调用 Deploy Hook。代码回归测试仍留在普通构建 CI 中。

推送后由已连接本仓库的 Vercel Git 集成自动构建部署。请保持 Vercel Production Branch 与仓库默认分支一致，并启用 Git 自动部署；若有 Ignored Build Step，不要忽略 `content/post/**/comments/` 的修改。CI 成功仅表示评论已推送，最终发布结果以 Vercel 为准。[Vercel Git 部署说明](https://vercel.com/docs/git/vercel-for-github)

GitHub Secrets 中原来专供评论发布的 `VERCEL_DEPLOY_HOOK_URL` 已不再需要；确认没有其他工作流使用后可删除。Vercel 侧的 `CRON_SECRET` 与 `VERCEL_DEPLOY_HOOK_URL` 仍用于每日自动部署，不受此次精简影响。

## 审批安全与并发

- 邮件包含签名而非加密的审批凭据，任何持有完整链接的人都能在有效期内批准该条评论，请勿转发。签名验证内容、站点与期限。凭据放在 URL fragment 中，不通过 GET 发给服务器；确认页读取后立即清除地址栏 fragment，不写 localStorage。
- 打开邮件链接只预览，不能直接触发 Action。必须在确认页点击按钮，用同源 POST 批准；GET/邮件链接扫描不会发布。
- 待审签名永远不返回给评论提交者；否则读者会获得自我审批能力。
- Action 参数使用派生的发布密钥和独立签名用途保护，不能把邮件链接直接当作 workflow 输入绕过确认。Action 从事件 JSON 读取参数，不把评论拼进 shell。
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

静态构建检查在临时文章副本中生成六层回复，验证父子关系、纯文本转义、文章隔离及父留言删除后的展示。将 `check-build.mjs` 输出的产物目录作为本地静态服务器根目录，再运行浏览器检查并设置 `SHIUE_TEST_REQUIRE_REPLIES=1`，可强制验证多层回复、popover 定位与关闭、按文章和回复对象隔离草稿、刷新后恢复及幂等重试、回复成功后保留独立留言草稿、存储与 Popover API 降级、浏览器时区与相对时间切换、无 JavaScript 展示。时间单元测试另覆盖夏令时、跨日及精确的 72 小时边界。

浏览器检查使用真实构建后的 Worker 计算并以 Node Crypto 验证证明，同时覆盖取消、超时、Worker 故障、不支持的浏览器、挑战服务不可用及过期后保留草稿。后端测试覆盖不配置任何限流变量时的完整流程，并确认挑战及预览没有额外外部请求；发布 CLI 在无 npm 依赖、无部署凭据的临时 checkout 中验证签名、推送及重复执行幂等。所有自动测试都不发送真实邮件、不调用 GitHub dispatch、不触发生产部署；Git 测试只操作临时仓库。配置好外部服务并部署后，再手动提交一条留言完成真实验收：浏览器验证 → 收邮件 → 核对内容 → 确认批准 → GitHub Action 成功 → 仓库新增评论文件 → Vercel 自动部署成功 → 页面出现留言。

- **503**：检查 PoW/邮件/审批配置、`comment-pages.json` 是否随函数打包，以及是否误用 Preview 环境。无需检查或创建限流规则。
- **502 / 未送达**：检查 Resend 发件域名、额度和 GitHub Token 权限。浏览器保留草稿/审批按钮，可重试。
- **PoW 403 / 410**：证明无效或过期，重新点击提交会重新获取挑战。若持续失败，检查是否刚轮换了密钥/难度、混用了不同环境或浏览器拦截了 Worker。不要移除服务端验证来解决。
- **验证超时**：草稿仍保留，可稍后重试或换浏览器；持续发生需用实际设备评估难度，不能无限占用 CPU。
- **审批过期**：让读者重新提交。密钥轮换也会使旧链接失效。
- **Action 失败**：在 Actions 查看失败步骤。验签失败时不写入；分支冲突/权限失败时不强推。可以重新运行 Action，文件幂等校验不会重复添加。
- **已推送但未展示**：检查 Vercel Git 连接、自动部署设置、生产分支、忽略构建规则及构建日志。Vercel 构建失败不会回滚 Git 中已添加的评论，修复后可在 Vercel 重新部署；重复审批已存在的评论不会制造新的提交来触发部署。

参考：[Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
