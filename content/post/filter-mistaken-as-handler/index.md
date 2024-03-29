---
title: "错把过滤器当处理函数"
date: 2024-03-22T07:08:04.950Z
slug: filter-mistaken-as-handler
description: 谢师傅使用RICQ框架和Atri插件化框架搭建聊天机器人的过程中遇到了一些问题，包括插件构建和加载、异步代码编写等，最终成功解决了问题。
categories:
- Rust
tags:
- RICQ
- Atri
- 插件化
- 异步编程
image: undefined
draft: false
---
下午一点，外面天气正好，刚起床没多久的谢师傅灵机一动想写一个能帮自己整理内容的聊天机器人。

考虑到之前使用 cqhttp 容易被风控，加之自己最近正在练手 Rust，于是谢师傅决定掏出自己很久以前看到的 **RICQ\[1\]** 框架。

 ![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zVibqQIrZPhnkCd3tY5iaJvoQcia29FxhoDRJPg7D1346KaRwgTQFHyQ6w/640?wx_fmt=png&wxfrom=5&wx_lazy=1&wx_co=1)

正巧看到 RCIQ 主页的衍生项目里有一个支持插件化的框架 **Atri\[2\]** ，于是便开始了今天的马戏团小丑之旅。

 ![Atri](https://mmbiz.qpic.cn/sz_mmbiz_png/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zCiaMczrVGxnzIjLLnYRO8nHzQuCibHCchfic4myoLgoLK06MOyhaIeZqA/640?wx_fmt=png&wxfrom=5&wx_lazy=1&wx_co=1 "right-50")

# **冷漠的 Atri**

谢师傅有一台本地运行的小主机可以充当服务器，为了机器人稳定可靠的运行谢师傅打算将 bot 跑在小主机上。

同时为了方便构建后马上部署，谢师傅特意在 macOS 上安装了 sshfs，但在此期间谢师傅碰到了不少可以再写一篇文章的各种问题，好在最终还是安装好了。

开始构建插件是在 macOS 上，编译出来的插件是 .dylib，谢师傅觉得很奇怪，他似乎很少见到 .dylib 的文件，但看文档里也是同样的格式谢师傅就认为这是 Atri 构建的插件的特性，于是乐呵呵的写了个 Makefile 一键构建并拷贝到 Atri 的插件目录。

但是似乎 Atri 假装什么都没发生，明明动态链接库就在那里，它却假装什么都没有，Atri 一脸冷漠的告诉谢师傅它加载了 0 个插件。

 ![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zDlZiakOae0CEoDwatKJYqg70WSFjvKEvyyDDFs7K0E1UyH50H3icK1GQ/640?wx_fmt=png&wxfrom=5&wx_lazy=1&wx_co=1)

谢师傅傻了，他想了半天也没想明白他做错了什么，会让 Atri 如此冷漠，对他的插件熟视无睹。他找遍了 Github 的 Issue，只发现了一个 **MUSL无法加载插件 #6\[3\]** 的问题，谢师傅想起来他好像就是用的 musl 版本，于是又哼哧哧把 Atri 换成 GNU 版本的，但 Atri 还是不理他。

谢师傅人傻了，就在谢师傅一筹莫展之时，他不经意瞟见一行字： ![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zCfFIh66ibTiatiaOWO9T2sTicVSNA3njU45bYrYJxen75dCEds7dOODdaA/640?wx_fmt=png&wxfrom=5&wx_lazy=1&wx_co=1)

armv7-unknown-linux-musleabihf ？谢师傅突然想起来一些关于跨平台交叉编译的事，这才后知后觉发现自己因为 sshfs 把文件系统给打通了让他下意识忽略了交叉编译的事！

谢师傅又是一顿折腾，这才给 cargo 加上交叉编译的工具链，直接make deploy，果不其然，这次 Atri 终于接受了谢师傅的插件：

 ![](https://mmbiz.qpic.cn/sz_mmbiz_png/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6z4PX6XPhedA6ozBbJiaY0ia07JGneoV2mtpTRcJwRm3hickYCFEQS4AkVA/640?wx_fmt=png&wxfrom=5&wx_lazy=1&wx_co=1)

# **选择性失明**

眼瞧着自己的插件终于跑起来了，高兴地手舞足蹈的谢师傅想要试试一些新功能，琢磨了一会，谢师傅觉着光让 bot 发文字没什么意思，于是谢师傅打算让 bot 先发张表情包试试。

可是谢师傅找了半天只找到了一个发送图片的接口，图片还得是本地的才行，沮丧的谢师傅于是打算先给 bot 做个保存自己发的表情包到本地的功能

于是自信的谢师傅洋洋洒洒写下以下代码：

```javascript
let guard = Listener::listening_on_always(|e: FriendMessageEvent| async move {
    let message = e.message();
    let mut message_str = message.to_string();
    if message_str.starts_with("收藏") {
        let name = message_str.split_off("收藏".len());
        let name = name.trim().to_string();
        let mut chain = MessageChainBuilder::new();
        chain.push_str("请发送表情");
        let _ = e.friend().send_message(chain).await;
        let v = Listener::next_event(Duration::from_secs(60), |e: &FriendMessageEvent| {
            let msg = e.message().to_string();
            println!("Message Element:{:?}", msg);
            for element in e.message() {
                if let MessageElement::Image(image) = element {
                    let n = name.clone();
                    storage(n.as_str(), image.url().as_ref());  // 下载图片并保存，内部使用 tokio 构建了一个阻塞式的方法，所以没有 await
                    let mut chain = MessageChainBuilder::new();
                    chain.push_str(format!("已保存").as_str());
                    let ch = chain.build();
                    match e.friend().send_message(ch).await {
                        Ok(v) => {
                            info!("发送成功✅:{:?}",v)
                        }
                        Err(err) => {
                            error!("发送失败：{:?}",err)
                        }
                    }
                }
            }
            true
        }).await;
    }
});
```

结果一向安静的 IDE 这时跳起来指着谢师傅的鼻子说😠：next_event里的闭包函数不支持 async/await，谢师傅人傻了，他没法在里面发送一个 “已保存” 的消息。

谢师傅很不服气，觉得接口设计者不太正常，但是事已至此也没办法了，随后叹了一口气，开始一顿折腾，上了一堆歪门邪道，包括但不限于在里面使用 tokio::block_on、tokio::spawn、以及框架自带的 block_on （那时的谢师傅并没有发现 block_on 是框架提供的，还以为是标准库中的方法）。

但是所有手段要么被提示不能在一个运行时内创建另一个运行时，要么就会遇到各种未知的段错误。

麻木的谢师傅后面经过测试发现似乎 atri 自己内部实现了一套运行时机制，并且与其他运行时不兼容，例如，以下代码就无法运行：

```javascript
use atri_plugin::runtime::spawn;

#[tokio::test]
async fn test() {
    spawn(async {
        println!("Hello")
    }).await.unwrap()
}
```

为了解决这个问题谢师傅尝试了各种方法，结果均以失败告终。

最后在谢师傅几近崩溃临近放弃之时随手将 Listener::next_event 方法的返回值赋值给了一个变量，谢师傅惊奇的发现这玩意居然有返回值！并且就是谢师傅一直需要的 FriendMessageEvent

 ![图片](https://mmbiz.qpic.cn/sz_mmbiz_jpg/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zqsbicY2OZMicDW68pgEbQUqCoPGt8O1iat9FauyV64VRTFmqSicW7anJPA/640?wx_fmt=jpeg&wxfrom=5&wx_lazy=1&wx_co=1)

那这不是意味着谢师傅没必要在闭包里写代码了吗？谢师傅高兴起来，直接把所有代码都迁到闭包外面了，而此时谢师傅也注意到了后面闭包的参数签名：**filter** ![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zLYcUvPbpjrJ5L6icUcqaMLaV7YCf1wBc8hB1iczHkkINickbx9UVbLhUA/640?wx_fmt=png&wxfrom=5&wx_lazy=1&wx_co=1)反应迟钝的谢师傅这才意识到，他三个小时都在研究怎么在 filter 里写异步代码！

谢师傅抑郁了。谢师傅这时想到他其实一开始就看到 IDE 提示他的那个小小的 filter，但是正高兴于 Atri 接受他的插件之时的谢师傅理所当然认为 Listener::next_event 与 Listener::listening_on_always 一样都是在回调里写逻辑于是直接忽略了 filter，并且对自己的写法笃信不疑。 ![图片](https://mmbiz.qpic.cn/sz_mmbiz_jpg/EkhJTM5kB9cFuA4icXsROn9n1VF9dDO6zqdgLoP8auZibmiaicYibzVKx5h5qX12BzaLXdrhkOA4luxD8KAba3ueiatA/640?wx_fmt=jpeg&wxfrom=5&wx_lazy=1&wx_co=1)好消息是谢师傅刚刚改完的代码终于成功跑起来了。

坏消息是这只会显得谢师傅这三个多小时是有多么的小丑。

### **参考资料**

\[1\] RICQ: *https://github.com/lz1998/ricq*

\[2\] Atri: *https://atrikawaii.github.io/atri_doc/*

\[3\] MUSL无法加载插件 #6: *https://github.com/LaoLittle/atri_bot/issues/6*