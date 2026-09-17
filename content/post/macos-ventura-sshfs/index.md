---
aliases:
- /feed/19/
date: 2022-10-01T10:58:34.000Z
description: ''
draft: false
lastmod: 2024-07-07T04:16:08.000Z
slug: macos-ventura-sshfs
tags:
- macOS
- sshfs
title: macOS Ventura 安装 sshfs
---
今天在调试 Atri [错把过滤器当处理函数的惨痛教训](https://xeu.life/feed/9) 的时候为了方便快速将构建出来的插件安装，于是灵机一动想到了 `sshfs`，但是 sshfs 在 macOS 安装还是有点小坑，特此记录一下
> **不要使用 Homebrew 安装 `sshfs`**
# 安装 OSXFUSE
在 macOS 上安装 `sshfs` 首先需要安装 `osxfuse` ，但是 `osxfuse` 使用 `brew install oxsfuse` 会出现报错提示版本不兼容
```
installer: Error - The FUSE for macOS installation package is not compatible with this version of macOS.

==> **Purging files for version 3.11.2 of Cask osxfuse**

Error: Failure while executing; `/usr/bin/sudo -u root -E LOGNAME=xeu USER=xeu USERNAME=xeu -- /usr/sbin/installer -pkg /usr/local/Caskroom/osxfuse/3.11.2/Extras/FUSE\ for\ macOS\ 3.11.2.pkg -target /` exited with 1. Here's the output:

installer: Error - The FUSE for macOS installation package is not compatible with this version of macOS.
```
这是因为 Homebrew 中安装的版本太老，仍然是 `3.11.2`，实际上本体已经更新到  `4.5.0` 了(截止发文时)，直接前往 Github Release 下载最新版本后安装即可（安装后需要允许插件并且重启）
<https://github.com/osxfuse/osxfuse/releases/latest>

# 安装 SSHFS
使用 Homebrew 安装会出现 sshfs 已经被归档弃用的说明：
```
Warning: sshfs has been deprecated because it has an archived upstream repository!

sshfs: Linux is required for this software.

libfuse: Linux is required for this software.

Error: sshfs: Unsatisfied requirements failed this build.
```
还是前往 Github Release 下载安装包手动安装：
<https://github.com/osxfuse/sshfs/releases/latest>

安装完成后即可使用 sshfs

## 挂载
```shell
sshfs user@hostname:/absolute/path/to/document local-file
```
## 卸载
```shell
umount local-file
```

## 其他问题
使用的时候发现 fuse 似乎在访达中显示的是一个挂载的磁盘但无法打开查看其内部内容，终端可以正常使用，问题倒是不大，只不过要是想要查看图片之类的操作的话可能比较麻烦（终端查看或者将文件拷贝到其他文件夹再打开）