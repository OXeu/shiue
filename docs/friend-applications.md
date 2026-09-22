# 友链申请

友链页提供站点名称、网址、简介和可选图标地址，申请流程与[留言](comments.md)相同：Turnstile 验证 → Resend 审核邮件 → 博主确认 → GitHub Action 导入友链与本地图标 → Git 自动部署。

接口为 `POST /api/submissions`，`type: "friend"`；`challenge` / `submit` / `preview` / `approve` 与评论一致，不支持 `notify`。已有邮件仍通过 `/friend-review/` 页面审核。

## 配置与上线

- 复用留言的全部配置（`COMMENTS_*`、`TURNSTILE_*`、`RESEND_API_KEY`），无需新增密钥；Turnstile 使用独立 action 并绑定申请内容，与评论令牌不互换。
- 先将 `.github/workflows/publish-friend.yml` 发布到默认分支，再部署函数和页面。
- 托管平台的生产分支须与默认分支一致，自动构建不能忽略 `data/friends.json` 或 `static/friends/`。
- `config/_default/params.toml` 的 `[friends] applications` 控制表单显示；关闭只隐藏入口，不关闭接口。

## 申请与审核

- 名称最多 80 字符，简介 200 字符，网址与图标 2,000 字符；仅接受公开域名的 HTTP(S)，拒绝凭据、IP、内网与自定义端口。
- 图标可留空，发布任务自动寻找 favicon / Apple Touch Icon；下载或解码失败则不添加条目。
- 提交与预览不请求申请者的网站，核对后确认才启动图标导入；格式检查不替代人工审核。
- 审批链接 7 天有效，打开仅预览，确认后发布；忽略邮件即不批准。
- 审核页与邮件以纯文本展示并转义 HTML，具备 no-store、no-referrer、noindex 与 CSP。
- 重复批准同一网址保留原条目，不覆盖名称、简介或图标；并发审批自动 rebase 重试，不强推。

## 上线验收

上线后提交一次真实申请，核对审核邮件、确认、Action 成功与页面展示。

排障：502 可保留内容重试；503 检查留言配置与环境；410 重新申请；已推送未展示时查 Git 部署记录。
