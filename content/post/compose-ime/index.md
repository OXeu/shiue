---
title: "Jetpack Compose Accompanist IME弹出状态问题"
date: 2022-02-14T16:31:52+08:00
draft: false
description: 实际使用WindowInset.ime.bottom和WindowInset.ime.isVisible时得到的结果比较奇怪...
slug: compose-ime
image: 94416502_p0.png
categories:
- Android
tags:
- Compose
- Android
---
> 封面来源 [Pixiv](https://www.pixiv.net/artworks/94416502)

## 问题

实际使用***WindowInset.ime.bottom***和***WindowInset.ime.isVisible***时得到的结果比较奇怪：

> 下文使用(int,bool)代表获取到的WindowInset.ime.bottom和WindowInset.ime.isVisible值

> 即(WindowInset.ime.bottom,WindowInset.ime.isVisible)

> 使用max代表获取到的WindowInset.ime.bottom最大值，即软键盘的像素高度

软键盘唤起的时：*(0,false) -> (0,true) -> ... ->(max,true)*

软键盘关闭时：*(0,true) -> (max,false) -> ... ->(0,false)*

实际使用时，可能还会出现某对值多次出现的情况[比如(0,true)]，

所以实际获取到的键盘高度可能会突然变成0，然后恢复正常，特别是在关闭键盘的瞬间，可能会造成界面闪烁。

## 解决方案

解决方案也十分简单，可以看出会导致状态异常的主要就是关闭键盘一瞬间产生的(0,true)，只要将其过滤掉即可，但是由于过滤掉后仍然无法得知真实高度，因此选择使用remember一个键盘高度变量，如果获取的值为(0,true)，那么直接不对键盘高度进行处理，直接使用上次正常的键盘高度即可，反之则直接将WindowInset.ime.bottom赋值给remember的变量即可



## 另外

`imePadding()`与 `‌systemBarPadding()` 合用时有时会失效，大概率是由于这两个方法所在的包不一致导致的（androidx.compose.foundation.layout 和 com.google.accompanist 中都有这两个方法），个人推测是由于WindowInset为单例，无法被两个包同时持有，在一个Activity中使用不同包的方法会导致持有WindowInset冲突，导致方法失效。

https://github.com/google/accompanist/issues/1016