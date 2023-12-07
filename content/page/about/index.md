---
title: 关于
slug: about
menu:
    main:
        weight: 5
        params:
            icon: user
---

学的很多，但都不精。  
目前个人主力语言可能还是 Kotlin，UI 主要靠 Jetpack Compose

用 Golang 写过后端，Rust 永远在入门以及入门路上，以及自己曾经的主力后端语言 PHP（现在不会写了），
从 WAP 模板建站时代(~~小学五年级~~)(~~[柯林](http://www.kelink.com/)~~)开始接触互联网，
从 iApp (~~初一到初三~~)接触到 App 开发,进而转正 Java (~~初三-高三~~)。

高考结束转战 Kotlin，自那以后很少写 Java 了。

喜欢新技术、假二次元(低浓度二次元)、偏激的内存强迫症、啥都喜欢 Self-host、半个UI设计师、半个产品经理、半个后端工程师、Android搬砖工、三分钟热度人。

经常性挖坑、弃坑。

当前个人开发的已发布App共2款：

[钢琴键](https://www.coolapk.com/apk/201165)

[lit浏览器](https://www.coolapk.com/apk/249180)

以及一个曾经 Android、iOS 都是自己写的，但是现在已经基本交给其他人写的App：

[BBHust](https://bb.hust.online)

## 接触过的技术债：

### Android(Java) 

钢琴键、Lit浏览器是用Java写的（因为当时高中没法用电脑，在手机上用AIDE写的，
后来项目有些东西AIDE没法编译的，当时就整了个AIDE通过Git Push触发Github Action编译构建APK文件，然后下载下来Matlog调试，
单次调试需要花五六分钟，而且还是高中半夜悄悄躲在被窝里搞，~~虽然现在看来挺蠢的~~，而且也相当程度的影响了我的学业，~~但也确实没学到多少东西~~,
当时学的最深的可能是WebView的底层工作原理，为了Hook`WebView`实现自定义播放器当时下了很大的功夫，从WebView源码一直翻到的Chromium源码。直到现在还印象深刻，~~虽然到最后也没研究出来就是了~~
）

### Android(Kotlin) 
目前是主力，BBHUST就是纯Kotlin写的

### Kotlin 
一般纯Kotlin用来写一些小脚本，特别是文件批处理很方便。
比如之前[汉化 Virtual Circuit Board](https://github.com/ThankRain/vcb_cn) 用的就是 Jupyter Notebook 但是 Kotlin 内核。
相比起 Python 个人更喜欢 Kotlin，~~可能是因为我不会 Python~~

### PHP
曾经用来写过钢琴键和Lit浏览器后台，从 ThinkPHP 写到 Laravel。

### Golang
主要用来写后台，后面也写过一些脚本/爬虫之类的，相较于 Kotlin ，Golang 在网络并发上面性能会好很多

### Rust
在学中（其实也没怎么在学），目前只用来写了个给服务器做每日备份至腾讯云COS的小程序(已噶)，给之前开坑的 Memox App 写过一次后端，~~后来改成 Golang 了~~。

### Swift
在学中，感觉Kotlin与Swift很多特性特别像，基本上可以无痛迁移。但是 XCode 真的很难用。心爱的 AppCode 也停止更新了 :(

### Jetpack Compose
Android 主力 UI 构建框架，常规 XML 布局已经不怎么会写了。

### Swift UI
只搓了 BBHust 一个项目以后就没碰过了

### Flutter
学过一段时间，曾经简单用Flutter写过BBHust。

### Vue
Vue 好玩捏，可惜自己没时间纯手搓一个博客出来。

### 焊板子
~~虽然不是技术~~现在会贴片了，但是万恶的 type-c 接口还是没学会，每次焊都会让临近的针脚短路:(