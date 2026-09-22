# 评论系统

无数据库的静态评论：Serverless Function 负责提交与审批，Resend 发审核邮件，GitHub Action 将批准的评论写入本仓库，Hugo 构建时生成静态 HTML。友链申请共用同一入口。

```text
读者提交 → Turnstile 验证 → Resend 审核邮件
        ↓ 博主确认
GitHub Action 写入评论 JSON 并推送
        ↓
Git 集成自动构建，Hugo 静态展示
```

评论与友链共用 `POST /api/submissions`，JSON 包含 `type: "comment" | "friend"` 和 `action`：`challenge` / `submit` 携带表单字段（`submit` 另带 `turnstileToken`），`preview` / `approve` 携带审批 `token`，评论另有 `notify` 用于重试通知。

## 使用与数据

- 昵称 + 纯文本留言（最多 2,000 字符），选填邮箱，支持多层嵌套回复。填写邮箱即同意接收审核通过与回复通知。不保存 IP、头像，不支持附件或 Markdown。
- 已批准评论直接在 HTML 中，无 JS 可读，阅读不请求 API，待审内容不进入公开仓库。
- 审批链接 7 天有效，过期需重新提交；不想通过时忽略邮件即可。
- 数据位于 `content/post/<文章目录>/comments/<UUID>.json`，字段为 `id`、`path`、`name`、`message`、`createdAt`，回复另有 `parentId`。
- 邮箱经 AES-256-GCM 加密保存（`emailEncrypted`、`emailHash`），静态页面、RSS 和搜索索引不展示邮箱。
- 编辑器在按钮旁以 popover 展开；草稿按文章和回复对象保存在 localStorage，跨标签页同步，提交失败不丢失。
- 评论时间按浏览器时区显示，72 小时内可在相对/绝对时间间切换。
- 修改或删除已发布评论直接 Git 提交即可；删除文件不等于抹除 Git 历史。
- 历史评论：已从旧站 Rin 接口恢复 105 条（合并去重、过滤垃圾、人工整理嵌套关系），来源记录在各评论的 `legacy` 字段。

## 1. 配置 Resend

在 Resend 验证发件域名并创建仅发送权限的 API Key，然后在函数平台的生产环境设置：

| 变量 | 含义 |
| --- | --- |
| `COMMENTS_SITE_URL` | 正式博客地址，HTTPS、末尾 `/`，用于校验 Origin 和生成链接 |
| `RESEND_API_KEY` | Resend 发送权限密钥 |
| `COMMENTS_EMAIL_FROM` | 已验证发件地址 |
| `COMMENTS_EMAIL_TO` | 接收审核邮件的本人邮箱 |
| `COMMENTS_SECRET` | 主密钥，`openssl rand -hex 32` 生成，函数平台与 GitHub 填同一值 |
| `TURNSTILE_SITE_KEY` | Turnstile 公开 Site Key |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key，只在函数运行环境 |

只需生成一个 `COMMENTS_SECRET`，程序用 HKDF-SHA256 自动派生审批、发布、邮箱三种用途密钥，留言和友链共用。不要把主密钥提交到仓库或输出到日志；主密钥需备份，丢失后无法迁移已有邮箱密文。

旧的分用途密钥（`COMMENTS_APPROVAL_SECRET` 等）仍兼容并优先覆盖；已有邮箱密文应保留原 `COMMENTS_EMAIL_SECRET` 直到完成重加密迁移。

### 读者通知

- 审批函数先成功发起 GitHub `workflow_dispatch` 再发读者通知；通知不等部署完成。
- 新留言作者填了邮箱就收审核通过通知；被回复且父留言有邮箱的作者收回复通知。收件人互相隔离。
- 发送失败不撤销发布任务，审核页可重试，重试凭据仅在当前页面有效，最多 24 小时。
- 每种通知使用固定幂等键，Resend 去重窗口 24 小时，跨窗口重放可能重复发信。
- 停止某条留言的后续通知：从其 JSON 删除 `emailEncrypted` / `emailHash` 并部署。

## 2. 配置 Turnstile

1. Cloudflare 控制台 **Turnstile → Add widget**，选择 **Managed**，添加正式域名 `xeu.life`。
2. Site Key / Secret Key 分别保存为 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`（Netlify 作用域需含 Functions；Cloudflare 设为 Secret）。
3. 保持 `COMMENTS_SITE_URL` 指向正式域名，Siteverify 返回的 hostname 需与其精确一致。
4. 配置后重新部署，在真实域名测试提交。缺少配置返回 503。

验证流程要点：

- `challenge` 返回 `sitekey`、内容摘要 `cData` 和提交编号，不请求 Cloudflare。
- 验证令牌 5 分钟有效、单次使用；cdata 绑定编号、文章、昵称、正文、时间与邮箱。
- 每次重试重新验证；草稿内容不设过期，重试记录临近 24 小时时自动以新编号重建提交。
- 脚本加载上限 15 秒，单次验证上限 90 秒；取消或失败均保留草稿。

全站 CSP 需允许 `script-src` 和 `frame-src` 的 `https://challenges.cloudflare.com`（仓库内审核页的严格 CSP 不受影响）。

**当前无应用层请求频率限制**，Turnstile 也不提供调用量或费用上限，重复审批仍可能启动工作流。

## 3. 配置 GitHub 发布

创建仅针对 `OXeu/shiue` 的 fine-grained PAT（权限：Actions: write），设为函数平台变量 `COMMENTS_GITHUB_TOKEN`。另设：

```text
COMMENTS_GITHUB_REPOSITORY=OXeu/shiue
COMMENTS_GITHUB_BRANCH=master
```

在 **GitHub 仓库 → Settings → Secrets and variables → Actions** 添加一个 Secret：

| Secret | 含义 |
| --- | --- |
| `COMMENTS_SECRET` | 与函数平台完全一致的主密钥 |

注意：

- 必须先把工作流文件部署到默认分支，GitHub 才能接受 dispatch；函数平台的环境变量不会自动同步成 GitHub Secrets。
- 发布工作流用 `GITHUB_TOKEN` 提交，无需推送 Token；仓库分支保护需允许此机器人提交。
- 审批函数拒绝 dispatch 时保留原始 GitHub 错误信息（限 8 KiB 内的 JSON），便于排查。
- 更新 `COMMENTS_GITHUB_TOKEN` 后需重新部署函数。
- 若平台配置了 Ignored Build Step，不要忽略 `content/post/**/comments/` 的修改。

## 审批安全

- 审批凭据签名不加密，持有完整链接的人都能批准，请勿转发；放在 URL fragment 中，不发给服务器。
- 打开邮件链接只预览，必须在确认页点击按钮以同源 POST 批准。
- 待审签名不返回给提交者，避免自我审批。
- Action 参数使用独立派生密钥签名，邮件链接不能直接作为 workflow 输入。
- 一条评论一个 UUID 文件，重复审批幂等；并发推送使用 fetch + rebase + 有界重试，不 force push。
- 确认页提供 no-store、no-referrer、noindex 与限制性 CSP。

## 验证与故障处理

```bash
npm run check:comments    # Turnstile、签名、邮件幂等、审批、并发写入
npm run check             # 完整回归
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  SHIUE_TEST_URL=http://127.0.0.1:1313/ node scripts/check-comments.mjs
```

浏览器检查覆盖桌面/手机布局、Turnstile 交互、失败保留草稿、无 JS 展示；全部使用模拟外部服务，不发送真实邮件或触发部署。上线后手动验收一次：真实提交 → 收审核邮件 → 批准 → Action 成功 → 页面展示。

| 现象 | 处理 |
| --- | --- |
| 503 | 检查 Turnstile / Resend / 审批配置，是否误用 Preview 环境 |
| 502 / 邮件未送达 | 检查 Resend 域名与额度、GitHub Token 权限 |
| 验证 403 / 410 | token 无效或内容不匹配，重新提交 |
| 验证超时 | 草稿保留，稍后重试或换浏览器 |
| 审批过期 | 让读者重新提交；密钥轮换也会使旧链接失效 |
| Action 失败 | 在 Actions 查看步骤；可重新运行，文件幂等不会重复添加 |
| 已推送未展示 | 检查平台 Git 连接、生产分支、忽略构建规则及构建日志 |
