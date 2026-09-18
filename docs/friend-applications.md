# 友情链接申请

友链页提供站点名称、HTTP(S) 网址、一句话简介和可选图标地址。申请采用与[留言](comments.md)相同的机制：浏览器完成 Turnstile 验证 → Resend 审核邮件 → 博主预览并确认 → GitHub Action 导入友链及本地图标 → 托管平台 Git 自动部署。不需要数据库；待审内容仅在审核邮件中，提交成功不代表已批准或邮件已投递到收件箱。

接口统一为 `POST /api/submissions`，请求 JSON 使用 `type: "friend"`；`action: "challenge"` 获取 Turnstile 组件配置，`submit` 携带表单字段及 `turnstileToken` 送审，`preview`、`approve` 携带审批 `token` 预览或发布。友链不支持评论专用的 `notify` 操作。已有邮件仍通过 `/friend-review/` 页面使用原令牌审核。

## 配置与上线

共用 `.env.example` 中现有的 `COMMENTS_*`、`TURNSTILE_*`、`RESEND_API_KEY` 配置。随机密钥只需一个 `COMMENTS_SECRET`，在 函数平台与 GitHub 设置相同值；程序自动派生各用途密钥，友链无需新增密钥。旧的分用途密钥仍兼容。Turnstile 使用独立的 friend action 并绑定申请内容，邮件审批和工作流签名也使用独立用途标识，与评论令牌不能互换。收件人、仓库和分支只由服务端指定。

先将 `.github/workflows/publish-friend.yml` 发布到默认分支，再部署 Serverless Functions 和页面。现有 GitHub Token 需要能 dispatch 该工作流（Actions: write）；工作流自身通过 `GITHUB_TOKEN` 的 contents: write 提交。托管平台的生产分支须与默认分支一致，自动构建不能忽略 `data/friends.json` 或 `static/friends/`。工作流安装项目依赖以复用现有的图标下载、校验和转换工具，不调用部署 Hook。

`config/_default/params.toml` 的 `[friends] applications = true` 控制表单显示；关闭它只隐藏入口，不关闭接口。Preview 环境拒绝发信和审批；本地 Hugo 不运行 API。

## 申请与审核

- 名称最多 80 字符，简介最多 200 字符；网址和图标地址最多 2,000 字符，仅接受公开域名的 HTTP(S) 网址，不接受登录凭据、IP、内网后缀或自定义端口。
- 图标可留空，由发布任务自动寻找 favicon / Apple Touch Icon；指定图标必须是完整 URL。下载或解码失败则不添加条目，可检查来源后在有效期内重跑任务。
- 提交与预览不会请求申请者的网站，也不会自动加载远程图标。核对网站与图标来源后点击确认，才启动图标导入；域名可能解析或跳转至其他地址，入口格式检查不替代人工审核。
- 邮件审批链接有效期为提交后的 7 天；凭据放在 URL fragment，确认页读取后清除地址栏，不存入浏览器存储。打开邮件链接只预览，GET 不发布；签名不返回申请者。忽略邮件即不批准。
- 审核页和邮件以纯文本展示用户字段并转义 HTML，站点内容不会当作 HTML 执行。页面具有 no-store、no-referrer、noindex 与 CSP 限制。
- 通过后使用现有 `data/friends.json` 数据格式及本地图标，申请编号和提交时间不加入友链名单。站点信息、图标及来源会保留在公开 Git 历史中。
- 重复批准已存在的网址会保留原条目，不覆盖名称、简介或图标。网址去重沿用现有导入工具（忽略 HTTP/HTTPS 差异和尾斜杠）。并发审批每次从最新远程分支独立导入，推送冲突最多重试 5 次，不强推、不覆盖其他友链或代码提交。

浏览器验证复用留言的 Turnstile 组件：主动提交才加载，可取消；失败保留表单，重试沿用编号与时间以保持邮件幂等，但需要新的 Turnstile token。无 JavaScript 时友链可阅读，申请按钮禁用。token 由 Siteverify 校验并单次消费；这不提供请求频率或费用上限。创建 Managed 组件、环境变量及排障见[留言配置](comments.md#2-配置-turnstile-与防滥用)。

## 验证

`npm run check:friend-applications` 覆盖校验、Turnstile 类型和内容隔离、签名篡改和过期、邮件幂等、确认后发布、重复与并发审批。使用临时 Git 仓库与模拟外部 API，不发送真实邮件、不触发线上发布。`node scripts/check-friend-applications.mjs` 使用与留言浏览器测试相同的 `PLAYWRIGHT_MODULE`、`SHIUE_TEST_URL` 环境变量。

上线后提交一次真实申请，核对审核邮件、预览确认、Action 成功、本地图标与名单提交以及 托管平台部署后的页面。502 可保留内容重试；503 检查现有留言配置和是否处于 Preview 环境；410 需重新申请。若任务已成功推送但页面未更新，检查 托管平台的 Git 部署记录。
