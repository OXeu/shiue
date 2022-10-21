---
title: "解决Rust二进制程序无法部署在Alpine容器中的问题"
date: 2022-10-21T23:08:41+08:00
description: 实际使用WindowInset.ime.bottom和WindowInset.ime.isVisible时得到的结果比较奇怪...
slug: compose-ime
image: cover.png
categories:
- Rust
tags:
- Rust
- Alpine
- Docker
draft: false
---
## 问题介绍

使用`Rust`开发的程序通过`cargo build`构建成功后在Ubuntu环境中运行良好，但当通过Docker使用Alpine容器部署该程序时，Dockerfile文件如下：

```dockerfile
FROM alpine
COPY ./app /root/lib
ENTRYPOINT ["/root/lib"]
```

构建镜像正常，但当运行镜像时发生以下错误：

```
Error loading shared library libgcc_s.so.1: No such file or directory (needed by ./lib)
```

## 解决方案

在Alpine容器中安装`libgcc`

```shell
apk add --no-cache -U libgcc
```

即将Dockerfile更改为下：

```dockerfile
FROM alpine
COPY ./app /root/lib
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories
RUN apk add --no-cache -U libgcc
ENTRYPOINT ["/root/lib"]
```

## 参考内容

[SIGSEGV with program linked against OpenSSL in an Alpine container - help - The Rust Programming Language Forum (rust-lang.org)](https://users.rust-lang.org/t/sigsegv-with-program-linked-against-openssl-in-an-alpine-container/52172)

[解决Alpine上Rust无法使用过程宏的方法 - 知乎 (zhihu.com)](https://zhuanlan.zhihu.com/p/138109387)