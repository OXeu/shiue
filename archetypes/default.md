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

