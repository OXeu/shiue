---
title: "{{ replace .Name "-" " " | title }}"
date: {{ .Date }}
description: "{{ replace .Name "-" " " | title }}"
slug: {{ .Name }}
image: cover.png
categories:
- 开发
tags:
- {{ replace .Name "-" "\n- " | title }}
draft: true
---

> 封面来源 [Pixiv](https://www.pixiv.net/artworks/)