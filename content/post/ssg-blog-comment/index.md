---

title: "为静态博客添加评论功能"
date: "2026-09-18T08:26:04.024Z"
description: "评论也能用 SSG 吗？用 Vercel Functions、Resend 和 GitHub Actions 串起邮件审核与静态评论，省去独立数据库，再聊聊我为什么执着于轻量化与长期可用性。"
slug: "ssg-blog-comment"
categories:

- tech
- essays
tags:
- blog
- SSG
- Serverless
- Vercel
- Resend
- GitHub Actions  
draft: false

---

## 一、评论也能用 SSG 吗？

虽然市面上已经有成吨的静态博客站点的评论插件，包括但不限于 Twikoo、Waline、Artalk、Giscus 等产品，但几乎所有插件（除 Giscus 以外，但它会污染 issue，并且依赖 GitHub 登录，个人并不是很喜欢）都需要配置后端和数据库。

虽然为了处理动态的评论需要数据库无可厚非，但总有些人喜欢追求极致轻量化（至于为什么后面再说），换个角度想想：博客的评论增加频率并不高，且对于实时性要求也一般，那评论真的需要动态显示吗？文章既然都可以用 SSG（Static Site Generator，静态站点生成器），**评论能不能也用上 SSG 呢？**

简单考虑下，让评论也用上 SSG 并不难，只需要在生成站点时将评论数据塞入模板中就行了，十分简单。至于如何实现半实时的评论更新稍微想想也不难，只需要在**有新评论时触发站点生成**就行了。

接下来的问题就变成了：如何将用户浏览器中编写的评论发送到我的博客代码仓库中？将 GitHub Token 硬编码到前端？让每个用户都能修改博客仓库的文件？这种方案想必只有刚从 SWE 幼儿园拿到及格分数的笨蛋 LLM 才会干得出来，**Token 肯定是不能直接暴露给前端的**，那就需要一个后端，Vercel Function 就不错。理论上做个 Vercel Function，调用时使用 GitHub Token 在指定目录下创建一个评论的文件就可以（实际实现的时候考虑到复杂度最终变成了派发一个创建评论的 GitHub Actions 工作流）。

但这种方式没有任何审核和反垃圾，要是有人刷一吨垃圾评论进去仓库就炸了，如何加入审核机制呢？如果维护一组待审核回复列表那不可避免还是会引入数据库或者存储服务。**但不引入的话，待审核评论保存在哪呢？**

*Thinking...*

![正在思考：脑袋上的进度条还在转](meme-thinking.gif)

---

> *发动俺寻思之力*...不引入常规的数据库和存储服务...Git 能否充当存储服务？...好像也不行，待审核评论里说不定有某些爆！爆！的东西，要是让所有人都能自由写任何内容进 Git 想必会大爆特爆...感觉需要某些分布式的东西...Git...Linus...Linux...邮件列表...邮件...
>
> **能否将评论直接发到我的邮箱，并提供一个审批按钮，这个按钮点击后会将评论文件写入 Git 仓库呢？**...直接将评论发到邮箱好像可以做，直接用 Vercel Function + Resend 就行...审批按钮点击的链接也接 Vercel Function 去写入 Git 好像就可以！...
>
> 但是这样的话审批按钮点击时就需要带上完整的评论数据，并且我们由于没有数据库和存储服务，其实也不太能做鉴权...如果有人尝试构造一个审批链接的话貌似可以直接绕过...因此可能需要对完整的评论数据做加密，这样就只有自己的 Vercel Function 有加解密的密钥，只要密钥不泄露就没办法构造一个审批链接出来...
>
> 但是如果有人刷 API 的话邮件会被打爆的...在评论的 API 前面加个简单的 [Anubis](https://anubis.techaro.lol/) 同款的**工作量证明**验证应该能减缓这个问题...再不济也只是把我的免费 Resend 额度刷光，让其他人没法评论而已...倒是没有明显的经济损失
>
> ---
>
> **补充**：工作量证明并不能完全杜绝自动化程序，且移动端算力较低，难度设置为 5 时 PC 端通常仅需约 5s 即可完成，但在移动端上却可能花费约 80s，导致极差的用户体验，因此此处在后面修改为了使用免费的 Cloudflare Turnstile 质询方案。

---

因此，最终凭借俺寻思之力，成功搓出了一个奇妙评论框架：

**评论 → Turnstile 验证 → 发送审核邮件 → 审批触发 GitHub Actions 将评论写入仓库 → 托管平台通过 Git 集成自动构建部署**

![Bingo！俺寻思这事能成](meme-bingo.gif)

由于邮件的 `<form>` 标签有概率被邮件提供商过滤掉，因此我们不能用 `POST` 的形式将加密的评论数据放到请求体中，而 URL 长度又有限制，如果评论内容直接放到 URL 中就会受到十分严格的长度限制：

> 不同浏览器的实际支持长度不同：
>
> - **Internet Explorer / 旧版 Edge**：最大限制为 **2083 个字节**。
> - **Google Chrome**：大约支持 **8182 个字符**。
> - **Mozilla Firefox**：支持 **65536 个字符**以上。
> - **Safari**：支持 **80000 个字符**以上。
> - **Opera**：支持 **190000 个字符**以上。

导致评论长度严重受限，怎么办呢？聪明的 Agent 直接**将加密的评论数据放到了 `fragment` 中**（就是 `#` 后面的部分，常用于锚点定位），最终大概的 URL 像这样：

```text
https://xeu.life/comment-review/#token=<加密后的评论payload>
```

而 `fragment` 的大小限制是多少呢？你可以访问这个页面在线测试当前浏览器允许的最大 `fragment` 尺寸：[浏览器 URL fragment 长度测试](https://fastjsonviewer.com/hash-length-limit.html)。

经过实测，Firefox 的 `fragment` 限制是 1MB，Chrome 以及 Chromium 内核的所有浏览器都**没有限制**，唯一的限制是设备的承载能力，非常的夸张。

![瞪大眼睛的猫耳少女：居然还能这样？](meme-shocked.gif)

至此整个框架实现完毕，延伸思考时发现在这套框架下甚至能实现**邮件通知评论人审核通过和被回复的信息**：

> **Agent：** 被回复者的邮箱，来自他当初发表那条评论时填写的“邮箱（选填）”。之后有人回复，服务端会在回复审核通过后，读取原评论保存的邮箱密文，解密并发送通知。
>
> 以「B 回复 A」为例，代码流程是：
>
> 1. **A 发表原评论时收集邮箱。** 前端把 A 填写的邮箱放入 `email` 字段，随评论提交到 Serverless Function。
> 2. **A 的评论审核通过时加密保存。** `sealComment()` 使用 AES-256-GCM 加密邮箱，公开评论 JSON 中保存 `emailEncrypted` 和 `emailHash`，不保存明文邮箱。
> 3. **网站构建时生成查询索引。** Hugo 把已发布评论的邮箱密文整理进 `comment-pages.json`，形成 `notificationEmails[评论 ID]` 映射，供审批接口读取。因此这里不需要查数据库。
> 4. **B 的回复审核通过后，取出 A 的邮箱并发信。** B 的回复通过 `parentId` 指向 A 的评论。审批接口成功启动 GitHub 发布任务后，用这个 ID 查到 A 的邮箱密文，再调用 `openCommentEmail()` 解密，通过 Resend 发送回复通知。
>
> *通知发送时，网站可能还没部署完成。* A 当初没填邮箱就不会收到通知；只通知直接被回复的人；双方邮箱相同时跳过回复通知，仅发送审核通过通知。

最终的整体架构如下：

```d2 {title="评论提交、审核发布与邮件通知的数据流"}
direction: down

classes: {
  secure: {
    style: {
      fill: "#e8f5ee"
      stroke: "#238636"
      font-color: "#173b25"
    }
  }
  storage: {
    style: {
      fill: "#eaf2ff"
      stroke: "#3975c6"
      font-color: "#183b65"
    }
  }
  sensitive: {
    style: {
      fill: "#fff4df"
      stroke: "#b7791f"
      font-color: "#654510"
    }
  }
  external: {
    style: {
      fill: "#f4edff"
      stroke: "#8250df"
      font-color: "#45257a"
    }
  }
}

serverless: {
  label: "无状态 Serverless 平台适配层"
  direction: right
  vercel: "Vercel Functions"
  netlify: "Netlify Functions"
  workers: "Cloudflare Workers + Static Assets"
  shared: {
    label: "任选一种入口注入 env、deployment、pages()，共用 server/submissions.js"
    class: secure
  }
  vercel -> shared
  netlify -> shared
  workers -> shared
}

submission: {
  label: "1 · 提交链路 · 统一 POST /api/submissions"
  direction: right
  form: "读者填写评论或回复：选填邮箱、parentId"
  challenge: {
    label: "Serverless action: challenge：校验同源、生产环境、内容及 comment-pages 白名单"
    class: secure
  }
  managed: {
    label: "浏览器按需加载 Cloudflare Turnstile Managed 组件并取得 token"
    class: external
  }
  submit: {
    label: "Serverless action: submit：复验内容、文章与父评论"
    class: secure
  }
  siteverify: {
    label: "Turnstile Siteverify：校验单次 token、hostname、action 与内容摘要 cData"
    class: external
  }
  moderationMail: {
    label: "从 COMMENTS_SECRET 派生审批密钥；Resend 发送带 7 天 HMAC 凭据的审核邮件"
    class: sensitive
  }
  form -> challenge: "同源 action: challenge"
  challenge -> managed: "返回 Site Key、action、cData"
  managed -> submit: "浏览器携 turnstileToken 自动提交"
  submit -> siteverify
  siteverify -> moderationMail: "验证通过；邮件使用固定幂等键"
}

review: {
  label: "2 · 邮件审核与批准 · 同一共享 API"
  direction: right
  inbox: {
    label: "博主收到私有邮件；待审数据不落数据库"
    class: sensitive
  }
  preview: {
    label: "审核页从 URL fragment 取出并清除凭据；action: preview 只展示"
    class: sensitive
  }
  approve: {
    label: "手动确认 action: approve：复验签名、期限、当前白名单与父评论"
    class: secure
  }
  seal: {
    label: "派生邮箱密钥：AES-256-GCM 加密选填邮箱，附带密钥摘要"
    class: secure
  }
  dispatch: {
    label: "派生发布密钥签名信封；GitHub API 接受 workflow_dispatch"
    class: external
  }
  inbox -> preview -> approve -> seal -> dispatch
}

publishing: {
  label: "3A · Git 持久化与 SSG 发布"
  direction: right
  action: {
    label: "publish-comment.yml：用同一 COMMENTS_SECRET 派生密钥并再次验签"
    class: secure
  }
  git: {
    label: "检查仓库、目录、父评论及循环；写入独立评论 JSON"
    class: storage
  }
  push: "Git commit + push：并发时 fetch / rebase / 重试，不强推"
  build: "托管平台 Git 集成运行 npm run deploy；Hugo SSG"
  html: {
    label: "静态 HTML：嵌套评论转义渲染；阅读不请求评论 API"
    class: storage
  }
  index: {
    label: "新 comment-pages.json：下次部署供 Node 函数包或 Workers ASSETS 读取"
    class: storage
  }
  action -> git: "拒绝明文邮箱；同 ID 同内容幂等，不覆盖冲突"
  git -> push -> build
  build -> html
  build -> index
}

notification: {
  label: "3B · 审批后的邮件通知"
  direction: right
  lookup: {
    label: "GitHub 接受任务后，从审批数据及当前 comment-pages 索引取得收件信息"
    class: sensitive
  }
  notify: {
    label: "仅服务端解密；Resend 分别发送审核通过和直接回复通知"
    class: sensitive
  }
  retry: {
    label: "部分失败时返回短期签名 notificationToken；action: notify 只重试失败邮件"
    class: secure
  }
  recipients: "评论者与直接被回复者收到邮件；同邮箱或未留邮箱时跳过"
  lookup -> notify: "每位收件人独立发送，使用固定幂等键"
  notify -> recipients
  notify -> retry: "仅部分通知失败时"
}

serverless.shared -> submission.challenge: "处理 challenge、submit 等 action"
submission.moderationMail -> review.inbox
review.dispatch -> publishing.action: "GitHub 接受任务后异步执行"
review.dispatch -> notification.lookup: "不等待 Action、构建或部署完成"
```

你可以在我的博客仓库中查看完整的源代码：[OXeu/shiue](https://github.com/OXeu/shiue)。

---

## 二、为什么还要追求极致轻量化？

话题回到为什么喜欢追求极致轻量化。其实无论是云端的小鸡亦或是本地的 homelab，我并不缺算力、存储去托管一个小小的博客评论系统，但我还是喜欢将其扔在 Serverless 提供商的基础设施上，且尽可能保持小巧，一方面是确实享受这种**在受限条件下创造带来的成就感**，另一方面则是**对自建基础设施可靠性的担忧**。

我的云端的小鸡说不定哪天就不续费或者换新小鸡了，本地的 homelab 说不定某天因为心血来潮直接干掉系统重做，或者是哪天硬盘突然飞升了数据没了，这些都可能导致这个小小的评论系统挂掉。我的个人实践结果表明，**个人自托管的基础设施可靠性远低于云服务厂商**，因此如果有可能让这个为数不多对外提供服务的小系统活得更久一点，我觉得折腾都是有必要的。

*谁也说不准明天和意外哪个先到*，但不难想象我在家里的小鸡大概率会随我飞升，云上的小鸡没人续费也活不了几年，但云服务厂商的免费托管，想必应该是其中能活得最久的那个。

![企鹅灵魂出窍，带着光环飞升](meme-ascension.gif)
