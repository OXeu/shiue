# 邮件审批 + Git 静态评论

不需要数据库，也不再使用 Twikoo。Serverless Functions 负责提交和审批；Resend 送审核邮件；GitHub Actions 将批准后的评论写入本仓库；Hugo 在构建时生成评论 HTML。

评论和友链共用 `POST /api/submissions`，JSON 请求必须包含 `type: "comment" | "friend"` 和 `action`。`challenge`、`submit` 携带原有表单字段，`submit` 另带 `turnstileToken`；`preview`、`approve` 携带审批 `token`。评论额外支持 `notify`，同时携带审批 `token` 和 `notificationToken`，只重试通知。未知类型或操作返回 400；Turnstile 按 action 区分两类提交，审批及发布签名仍相互隔离。

旧的六个 API 路径已移除，表单及审核页统一调用新入口。已有审核邮件仍可打开原 `/comment-review/` 或 `/friend-review/` 页面，令牌格式和有效期不变。

```text
读者提交 → action: challenge → 浏览器完成 Turnstile 验证
                         ↓ 带 token 提交
             action: submit → Siteverify → Resend → 博主收到审核邮件
                                                ↓
                                 邮件链接打开评论预览（不发布）
                                                ↓ 手动确认
                                   action: approve
                                                ↓ 签名 workflow_dispatch
                                   publish-comment.yml
                                                ↓
                            验签 → 独立 JSON → commit + push
                                                ↓
                               托管平台的 Git 集成自动构建部署
                                                ↓
                                  Hugo 静态 HTML 展示评论
```

## 使用与数据

- 支持文章页的昵称 + 纯文本留言（最多 2,000 字符）、选填邮箱及多层嵌套回复，每条留言或回复都可继续被回复。填写邮箱即同意接收该条留言的审核通过和直接回复通知；留空仍可正常提交。不保存 IP 或头像，不提供附件或 Markdown。评论代码不读取 IP 做限流；基础设施仍可能保留含 IP 的访问日志。
- 已批准评论直接显示在 HTML 中，无 JavaScript 也可阅读；阅读不请求评论 API。不在评论区展示待审内容。
- 提交成功仅表示 Resend 接受了审核邮件，不表示已批准，也不保证邮件已投递至收件箱。审批成功仅表示 GitHub 接受了任务，不表示部署已经完成。
- 不想通过时忽略邮件即可。没有额外的待审数据库，待审内容留在邮件中。审批链接从提交时间起 7 天内有效；过期需重新提交。
- 数据位于各文章目录的 `content/post/<文章目录>/comments/<UUID>.json`，基础字段为 `id`、`path`、`name`、`message`、`createdAt`；回复另有 `parentId`，指向直接父留言的 UUID，顶层留言省略该字段。Hugo 从文章资源读取留言，按父子关系静态渲染，同级按提交时间排序，正文和昵称转义为纯文本。
- 选填邮箱经格式校验后绑定 Turnstile 内容摘要和审批签名。明文只用于服务端处理及私有审核凭据，发布时使用 AES-256-GCM 和随机 nonce 加密，附加认证数据绑定留言编号与文章路径。公开留言文件只保存 `emailEncrypted` 和带密钥的 `emailHash`；后者用于判定重复审批，不能据此直接枚举邮箱。GitHub Action 的发布脚本不解密邮箱，并拒绝写入明文 `email` 字段。静态页面、RSS 和搜索索引不展示邮箱，`comment-pages.json` 只携带供审批函数使用的邮箱密文。
- `comment-pages.json` 白名单包含文章 URL、标题、源目录和已发布留言编号。提交与审批只接受同一文章下的已发布父留言；Turnstile 内容摘要和审批签名都绑定 `parentId`。发布目录由白名单确定并签名，不能由访客指定，也不依赖 URL 与文章文件夹同名。Action 会再次核对实际文章、父留言和循环引用。
- 编辑面板默认隐藏，点击标题栏留言数量后的「评论」或昵称、时间行右侧的「回复」文本链接，在按钮旁打开 popover 并聚焦输入框。点击外部、关闭按钮或 Escape 可收起；键盘关闭后焦点返回触发按钮。小屏下限制面板宽高并允许内部滚动，标题与关闭按钮始终可见。
- 草稿按文章路径及直接回复对象分别保存在浏览器 localStorage，包括昵称、选填邮箱、正文、公开同意状态及失败重试编号；关闭、切换对象、刷新和离开后返回均可恢复。提交失败保留草稿，成功只清除当前对象的草稿；点击标题栏「评论」可恢复独立留言草稿。存储不可用时保留本页内存草稿并提示无法跨刷新保存。
- 同一浏览器、同一站点的标签页同步草稿编辑与删除；页面恢复或重新打开编辑器时读取最新草稿，未编辑的旧页面不会在关闭时回写。发送期间另一标签页修改的版本会保留。不同浏览器、设备或浏览器配置文件的本地草稿彼此独立，不支持跨浏览器同步。
- 评论时间按浏览器本地时区显示。未满 72 小时的留言显示「刚刚」「N 分钟前」「N 小时前」「N 天前」，点击或按 Enter / Space 可往返切换绝对时间；满 72 小时后固定显示绝对时间。页面停留期间定期更新时间；无 JavaScript 时显示带时区标识的静态时间。
- 回复层级不设业务上限，深层回复限制视觉缩进以适配手机。父留言删除后已有回复仍会展示，并标明原留言已删除；新回复的直接父留言必须存在。
- 原 `data/comments/` 只有占位文件，本次已移除，没有存量留言需要搬迁。旧版已发出的有效审批邮件仍可确认，审批时会按当前白名单选择新的文章目录；升级前已签发的工作流参数缺少文章目录，需从原审批邮件重新确认。
- 修改/删除已发布评论可通过普通 Git 提交进行，随后部署。删除文件不等于抹除公开 Git 历史。审批链接有效期内重放可能重新添加已删除的文件；如需单独撤销未过期审批，可设置或轮换兼容覆盖项 `COMMENTS_APPROVAL_SECRET`，不改动邮箱加密密钥。
- 已从 `legacy.xeu.life` 的 Rin 公开接口恢复 105 条历史评论：原有 137 条中合并 11 条重复提交、过滤 21 条测试/无意义/纯引流留言，并根据语义人工整理了 29 条回复的嵌套关系，详见 [旧站评论恢复](legacy-comments-migration.md)。来源编号保存在每条评论的 `legacy` 字段中，推断关系另有依据记录。不导入邮箱等非展示资料，也不修改旧服务数据；更早的 Twikoo 数据库不在此次范围内。

## 1. 配置 Resend

在 Resend 验证发件域名并创建仅允许发送邮件的 API Key。建议为审核邮件关闭点击和打开跟踪，保留原始 URL fragment。发件地址必须属于已验证域名；审核邮件收件人由服务端固定，读者通知收件人只能取自已签名的留言邮箱或已发布父留言的邮箱密文。

在所选平台的生产函数环境设置以下变量（Vercel、Netlify、Cloudflare Workers 的具体入口见[多平台部署](serverless.md)）：

| 变量 | 含义 |
| --- | --- |
| `COMMENTS_SITE_URL` | 正式博客地址，HTTPS、末尾 `/`；当前为 `https://xeu.life/`。用于校验 Origin、生成原文/审批链接 |
| `RESEND_API_KEY` | Resend 发送权限密钥 |
| `COMMENTS_EMAIL_FROM` | 已验证发件地址，例如 `Xeu Blog <comments@xeu.life>` |
| `COMMENTS_EMAIL_TO` | 接收审核邮件的本人邮箱，不会打包进前端或评论文件 |
| `COMMENTS_SECRET` | 唯一需要生成的随机主密钥，至少 32 字符；函数平台与 GitHub 同名 Secret 设置相同值，程序自动派生各用途密钥 |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 公开 Site Key，组件选择 Managed |
| `TURNSTILE_SECRET_KEY` | 同一组件的 Secret Key，只保存在函数运行环境，不传给前端或 GitHub |

只需运行一次 `openssl rand -hex 32`，将输出分别填入 函数平台和 GitHub 的 `COMMENTS_SECRET`。代码使用 HKDF-SHA256 按审批、发布、邮箱三种用途派生不同密钥，留言和友链共用这一配置。无需手动生成或填写派生密钥。函数平台与 GitHub 都保存主密钥；不要把它提交到仓库或输出到日志。`.env.example` 只有空值模板；`.env`、`.env.*` 与 `.vercel/` 已被忽略。

旧配置继续兼容：非空的 `COMMENTS_APPROVAL_SECRET`、`COMMENTS_WORKFLOW_SECRET`、`COMMENTS_EMAIL_SECRET` 优先覆盖相应用途，这些覆盖项在升级后保持原有用途。新安装只填 `COMMENTS_SECRET`。删除旧覆盖项才会切换到该用途的派生密钥，也会使依赖原密钥的未过期凭据失效；发布密钥的覆盖项须在 函数平台与 GitHub 保持一致。已有邮箱密文则应保留原 `COMMENTS_EMAIL_SECRET`，直到完成重加密迁移。主密钥需备份，不能通过直接删除旧邮箱密钥或更换主密钥来迁移既有密文。

### 读者通知

- 审批 Serverless Function 先成功发起 GitHub `workflow_dispatch`，随后等待 Resend 接受通知邮件再返回，不使用返回响应后可能被中断的后台发送。GitHub 拒绝任务或仅预览时不发送读者通知。通知不等待 Action、Git 推送或部署完成，文案明确为“已通过审核，正在发布”。
- 新留言作者填写了邮箱，就发送审核通过通知；该留言是回复且直接父留言保存了邮箱，就向父留言作者发送回复通知。不会通知所有祖先，也不会在未审批时通知。两种通知收件人分别发送，不互相暴露邮箱；自回复且邮箱相同时仅发送审核通过通知。
- 发送失败不撤销已接受的发布任务。审核页显示失败提示及“重试发送通知”，使用单独签名的重试凭据，仅重试失败的通知，不再次启动 GitHub Action。重试凭据只留在当前审核页内存中，最多 24 小时且不超过原审批有效期；刷新后需重新打开审核邮件。
- 每种通知使用固定幂等键，避免超时后立即重试造成重复发送。[Resend 的去重窗口为 24 小时](https://resend.com/docs/dashboard/emails/idempotency-keys)；无数据库模式不承诺跨窗口永久去重，超过窗口重新审批可能再次发信。Resend 接受不等于收件箱投递成功。
- 停止某条已发布留言的后续回复通知，可从其 JSON 删除 `emailEncrypted` 和 `emailHash` 并部署。密文仍可能留在公开 Git 历史中；已发出的审核凭据或通知重试凭据在有效期内仍可重放。

## 2. 配置 Turnstile 与防滥用

评论和友链使用 Cloudflare Turnstile，已移除浏览器 SHA-256 PoW Worker。Vercel、Netlify、Cloudflare Workers 共用同一个服务端验证器；无需迁移托管平台、DNS 或开启 Cloudflare CDN。

1. 在 Cloudflare 控制台的 **Turnstile → Add widget** 创建组件，选择 **Managed**，添加实际生产域名 `xeu.life`，不填写协议或路径。
2. 将同一组件的 **Site Key** 和 **Secret Key** 分别保存为生产函数环境变量 `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`。Netlify 的作用域需包含 Functions；Cloudflare 将 Secret Key 设为 Secret。两项均在运行时读取，不需要加入 Hugo 配置或 GitHub Actions。
3. 保持 `COMMENTS_SITE_URL` 指向正式域名。服务端要求 Siteverify 返回的 hostname 与该地址的 hostname 精确一致；别名域名应先重定向到正式域名。预览和开发环境仍禁止提交、发信和发布。
4. 配置环境变量后重新部署函数和页面，再在真实域名测试评论及友链提交。缺少配置会返回 503，不会退回 PoW 或跳过验证。打开旧页面的用户需要刷新。
5. `COMMENTS_POW_DIFFICULTY` 和 `COMMENTS_POW_SECRET` 已不再读取，可从托管平台删除；无需轮换 `COMMENTS_SECRET` 或其他旧密钥，已有审批链接和邮箱密文继续兼容。

[Turnstile 官方说明](https://developers.cloudflare.com/turnstile/) · [服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

### 验证流程

1. 主动提交后，`action: "challenge"` 先校验表单及文章白名单，返回公开的 `sitekey`、`action: "comment" | "friend"`、规范化内容的 SHA-256 摘要 `cData` 及 `submission: { id, createdAt }`。前端保存并使用返回的编号与时间继续验证和提交。这一步不请求 Cloudflare，也不返回任何密钥或审批凭据。
2. 页面按需加载官方 `https://challenges.cloudflare.com/turnstile/v0/api.js`，在表单中渲染组件；只有需要额外交互时显示验证组件。仅阅读文章或审核邮件页面不会加载 Turnstile。
3. 前端将验证得到的 `turnstileToken` 随原表单发送给 `action: "submit"`。服务端调用固定 Siteverify 地址，检查 `success === true`、hostname、action、cdata 和验证时间后才发审核邮件。cdata 绑定规范化的编号、文章、昵称、正文、时间、回复对象和选填邮箱；友链绑定全部申请字段。
4. 验证令牌有效期为 5 分钟且只能验证一次。网络异常、无效/重放令牌、域名/类型/内容不匹配都不会发邮件；Siteverify 10 秒超时，禁止跟随重定向，响应及日志不暴露密钥或上游错误。调用 Siteverify 不附带 IP 或明文表单字段；浏览器会连接 Cloudflare 接受验证。
5. 每次重试重新完成验证，有效期内未改动的表单沿用编号与提交时间，使邮件幂等键保持一致。草稿内容不设过期时间；重试记录达到 23 小时 55 分钟（为验证预留 5 分钟）或客户端时间超前服务端 5 分钟以上时，challenge 自动以服务端当前时间及新编号建立提交，不要求用户刷新或修改正文。编号和时间一起更新，避免同编号对应不同内容；提交接口仍严格校验时间及验证摘要。邮件请求失败后不能复用已经验证过的 token。

脚本加载上限 15 秒，单次验证等待上限 90 秒；超时、不支持的浏览器、加载失败或取消都会移除组件并保留草稿。验证阶段可以取消；开始发送后不再显示取消按钮。成功后清除当前草稿。取消加载不会在脚本稍后到达时重新启动已取消的验证。

如果在平台额外配置了全站 CSP，需要允许 `script-src https://challenges.cloudflare.com` 和 `frame-src https://challenges.cloudflare.com`。仓库内的严格 CSP 只应用于审核页面，这些页面不运行 Turnstile，无需放宽。[CSP 接入要求](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)

仍保留同源校验、JSON 大小限制、文章白名单、隐藏诱捕字段、重复点击保护和邮件幂等。Origin 不能单独当作反机器人机制。

**当前仍没有应用层请求频率或总量限制。** Turnstile 不提供 Function 调用量、邮件费用或 DDoS 的硬上限；重复审批仍可能启动工作流。旧的 `COMMENTS_RATE_LIMIT_ID`、`COMMENTS_CHALLENGE_RATE_LIMIT_ID` 不再读取，也无需配置。此次接入不修改平台已有的限流规则。

## 3. 配置 GitHub 发布权限

创建只针对 `OXeu/shiue` 的 fine-grained PAT，权限只需 **Actions: write**（以及默认 Metadata: read）。将它设置为 函数平台的生产环境变量 `COMMENTS_GITHUB_TOKEN`。它只用于请求 `publish-comment.yml`，不提供给浏览器、邮件或工作流输入。也可替换为生命周期受控的 GitHub App installation token，但当前实现不会自动续签。

继续设置 函数平台的生产环境变量：

```text
COMMENTS_GITHUB_REPOSITORY=OXeu/shiue
COMMENTS_GITHUB_BRANCH=master
```

仓库默认分支必须与上面的分支一致；工作流仅在默认分支执行。在 **GitHub 仓库 → Settings → Secrets and variables → Actions** 只需手动添加一个 Repository secret：

| Secret | 含义 |
| --- | --- |
| `COMMENTS_SECRET` | 与 函数平台同名变量完全一致，只需复制同一主密钥 |

发布工作流通过 GitHub 自动提供的 `GITHUB_TOKEN`（`contents: write`）提交评论，无需另配推送 Token。`COMMENT_FILE` 来自验签步骤输出，`COMMENTS_BRANCH` 来自仓库默认分支，其他 `GITHUB_*` 上下文由 Actions 提供；这些都不需要手动配置。仓库规则/分支保护仍然生效，需要允许此机器人提交；若仓库要求所有修改必须走 PR，本版本会安全失败，不会绕过保护。

必须先把工作流文件部署到默认分支，GitHub 才能接受 dispatch。函数平台的环境变量不会自动同步成 GitHub Secrets，`COMMENTS_SECRET` 两边要分别设置成相同值。工作流保留对旧 `COMMENTS_WORKFLOW_SECRET` 的兼容，新安装无需配置它。评论工作流只做 checkout、准备 Node、验签写文件、提交推送；两个发布脚本只用 Node 内置模块，不安装 npm 依赖，不运行测试或 Hugo 构建，也不调用 Deploy Hook。代码回归测试仍留在普通构建 CI 中。

GitHub 拒绝 workflow dispatch 时，审批接口保留本站的 502 网关状态，并返回 GitHub 原始 JSON 错误对象中的 `message`、`errors`、`documentation_url`、`status` 等字段及真实 HTTP 状态，避免按状态码猜测原因。只有不超过 8 KiB 的 JSON 对象会透传；鉴权头、发布 envelope、环境变量及非 JSON 响应不会返回页面。更新 `COMMENTS_GITHUB_TOKEN` 后需要重新部署函数。

推送后由已连接本仓库的 托管平台的 Git 集成自动构建部署。请保持 托管平台的生产分支 与仓库默认分支一致，并启用 Git 自动部署；若有 Ignored Build Step，不要忽略 `content/post/**/comments/` 的修改。CI 成功仅表示评论已推送，最终发布结果以托管平台 为准。[Vercel Git 部署说明](https://vercel.com/docs/git/vercel-for-github)

每日自动部署已改为 GitHub Actions 推送空提交，评论发布和每日刷新均不再使用 Deploy Hook。若没有其他用途，可删除 Vercel 与 GitHub 中旧的 `CRON_SECRET`、`VERCEL_DEPLOY_HOOK_URL`，以及 Vercel 控制台中的旧 Deploy Hook。

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
npm run check:comments                 # Turnstile 验证、签名、篡改、过期、邮件幂等、审批和临时 Git 并发测试
npm run check                         # 包括临时评论的静态渲染、XSS 转义与文章隔离检查
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  SHIUE_TEST_URL=http://127.0.0.1:1313/ node scripts/check-comments.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  SHIUE_TEST_URL=http://127.0.0.1:1313/ node scripts/check-comment-drafts.mjs
```

静态构建检查在临时文章副本中生成六层回复，验证父子关系、纯文本转义、文章隔离及父留言删除后的展示。将 `check-build.mjs` 输出的产物目录作为本地静态服务器根目录，再运行浏览器检查并设置 `SHIUE_TEST_REQUIRE_REPLIES=1`，可强制验证多层回复、popover 定位与关闭、按文章和回复对象隔离草稿、刷新后恢复及幂等重试、回复成功后保留独立留言草稿、存储与 Popover API 降级、浏览器时区与相对时间切换、无 JavaScript 展示。时间单元测试另覆盖夏令时、跨日及精确的 72 小时边界。

`check-comment-drafts.mjs` 同样使用该临时产物，以真实提交处理器和模拟外部服务验证跨天草稿自动续期、失败刷新后的邮件幂等、多标签页同步、暂停页面防回写、发送期间的新编辑保护及回复草稿隔离。

浏览器检查使用真实构建页面与模拟的 Turnstile SDK，覆盖桌面/手机布局、交互式组件、脚本加载失败、取消、离开页面、超时、组件错误、过期及失败后保留草稿。服务端测试模拟 Siteverify，覆盖成功、无效/重放 token、域名/action/cdata 不匹配、网络故障和各平台完整流程。自动测试不调用真实 Turnstile、不发送邮件、不触发 GitHub dispatch 或生产部署；Git 测试只操作临时仓库。部署并配置真实密钥后，需手动验收：真实域名完成验证 → 收审核邮件 → 核对并批准 → GitHub Action 成功 → 页面展示。

- **503**：检查 Turnstile/邮件/审批配置、当前平台是否能读取构建生成的 `comment-pages.json`，以及是否误用 Preview 环境。无需检查或创建限流规则。
- **502 / 未送达**：检查 Resend 发件域名、额度和 GitHub Token 权限。浏览器保留草稿/审批按钮，可重试。
- **验证 403 / 410**：token 无效、已使用、过期或提交内容不匹配。重新提交会获取新 token；持续失败时检查 Turnstile 允许域名、Site Key/Secret Key 是否属于同一组件及 COMMENTS_SITE_URL。不要跳过服务端验证。
- **验证超时**：草稿仍保留，可稍后重试或换浏览器；持续发生时检查网络、浏览器扩展及 Turnstile 域名是否被拦截。
- **审批过期**：让读者重新提交。密钥轮换也会使旧链接失效。
- **Action 失败**：在 Actions 查看失败步骤。验签失败时不写入；分支冲突/权限失败时不强推。可以重新运行 Action，文件幂等校验不会重复添加。
- **已推送但未展示**：检查 托管平台的 Git 连接、自动部署设置、生产分支、忽略构建规则及构建日志。托管平台构建失败不会回滚 Git 中已添加的评论，修复后可在托管平台重新部署；重复审批已存在的评论不会制造新的提交来触发部署。

参考：[Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
