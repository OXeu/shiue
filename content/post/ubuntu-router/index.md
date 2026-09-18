---
aliases:
- /feed/30/
- /ubuntu-router/
date: 2024-11-30T10:01:55.000Z
description: 由于懒狗实习转正以后就没有投秋招了，考虑到后续也打算在广州常住，因此也是开始折腾一些之前短租时不敢折腾的东西了，首要需求就是能够让我在广州也能畅通无阻的连接到我仍在学校的机器。出于个人喜好，打算再购置一台 mini 主机作为网关/路由器（没错我在学校也有一台 mini 主机做路由）
draft: false
image: /images/0b50fcedcf59be551a7697b0.jpg
lastmod: 2026-01-15T13:02:06.000Z
slug: ubuntu-router
tags:
- Ubuntu
- router
- networking
title: Ubuntu Router 配置
---
![P20241130-183531(1).jpg](/images/0b50fcedcf59be551a7697b0.jpg)

# 前言
由于懒狗实习转正以后就没有投秋招了，考虑到后续也打算在广州常住，因此也是开始折腾一些之前短租时不敢折腾的东西了，首要需求就是能够让我在广州也能畅通无阻的连接到我仍在学校的机器。出于个人喜好，打算再购置一台 mini 主机作为网关/路由器（没错我在学校也有一台 mini 主机做路由）

考虑到单网口的 mini 主机在不外接 USB 网卡的情况下通常只能使用旁路由的方案，有一定限制，因此优先考虑自带双网口，最终选择了某不知名厂家的 N100 16+512 配置的 mini 主机

![cc4e82cc28de67f610ad9931349102d3.jpg](/images/55b849db64ea7bbe9bdaf4bc.jpg)

> 至于问到为什么只是充当网关作用的主机需要 16 + 512 这么奢华的配置？其实我自己也很想问问当时为什么没有选择 ￥675 能拿下的 8 + 256 配置，也许是后续打算再扔点服务在上面？我自己已经没印象了，只是现在觉得这也太奢侈了

之所以选择这款其实是因为某东没有更多的选择（很急，已经习惯某东的次日达了，现在都不愿意等 3 天到货了）

# 配置

机器到手，首先就是装系统，这里在 Ubuntu 和 ArchLinux 之间反复横跳，最终在折腾多次配置后还是选择了 Ubuntu。

> 至于 OpenWRT 则是从未考虑过的，主要是并不是只打算将它做纯路由器，也给后续留点折腾的余地

## Netplan

使用 netplan 对接口进行划分，以我的小主机为例，将 enp3s0 作为 WAN 口连接上级光猫，enp1s0 作为 LAN 口连接子网设备

```yaml
# /etc/netplan/50-cloud-init.yaml
network:
  version: 2
  ethernets:
    enp1s0:
      addresses:
      - "10.0.2.1/24"
      - "fd00::1/64"
    enp3s0:
      dhcp4: true
```

dhcp6 不开，避免上级不使用 DHCPv6 分配地址导致开机卡 wait-online （未验证）


## DHCP Server

现在接口的 ip 地址已经配置完毕，确保路由器本机已经可以上网了，但子网设备还拿不到 ip 地址，于是开始配置 DHCP 服务器，这里使用 dnsmasq

```toml
# /etc/dnsmasq.d/router.conf
# 监听的网卡
interface=enp1s0
listen-address=127.0.0.1,10.0.2.1,fd00::1,::1

server=8.8.8.8
# DHCP分配地址的范围、掩码、租期等
dhcp-range=10.0.2.2,10.0.2.200,255.255.255.0,12h
# 设置网关
dhcp-option=3,10.0.2.1
# 通过MAC地址手动绑定IP
dhcp-host=00:e0:4c:73:1a:74,10.0.0.1
dhcp-host=00:e0:4c:73:1a:74,fd00::1
# DHCP分配DNS服务器地址配置
dhcp-option=option:dns-server,114.114.114.114
# IPv6
dhcp-option=option6:dns-server,[2400:3200::1]
dhcp-range=fd00::2, fd00::500, 64, 12h
enable-ra
# 关闭DNS解析服务
port=0
```

由于几经尝试也没有获取到广州联通光猫的超级管理员密码，导致无法修改光猫为桥接模式，于是这里 ipv6 选择 NAT6 为子网分配局域网 IPv6 地址


> 这里我使用 dnsmasq 分配 IPv6 地址出现了不续约或者后续掉分配的情况，暂不清楚是配置原因还是其他原因(重启路由器好了)，保险起见还选择了使用 radvd 来分配 IPv6 地址: 
>
> ```toml
> sudo apt install radvd
> sudo vim /etc/radvd.conf
> ```
>
> ```toml
> # /etc/radvd.conf
> interface enp1s0 {
>         AdvSendAdvert on;
>         prefix fd00::/64{
>                 AdvOnLink on;
>                 AdvAutonomous on;
>         };
> };
> ```
>
> 启动 radvd 服务：
>
> ```toml
> systemctl enable --now radvd
> ```
>
> 改为 radvd 之后发现可以获取到 IPv6 地址但没有获取到 IPv6 DNS，好在即便是 IPv4 的 DNS 通常也是能够返回 IPv6 查询结果的，可以先这样用着

## iptables

不出意外的话现在子网设备已经能拿到 ipv4 和 ipv6 地址了，但是仍然无法上网，主要原因还没有配置路由表与转发。输入以下命令配置 ipv4 与 ipv6 的 NAT 转发策略，将 enp3s0 修改为自己的 WAN 接口名称

```toml
iptables -A FORWARD -j ACCEPT
iptables -t nat -A POSTROUTING -o enp3s0 -j MASQUERADE
ip6tables -A FORWARD -j ACCEPT
ip6tables -t nat -A POSTROUTING -o enp3s0 -j MASQUERADE
```

同时编辑 `/etc/sysctl.conf`，在末尾追加以下内容

```toml
# /etc/sysctl.conf

# ..... 其他配置

net.ipv4.ip_forward=1
net.ipv4.conf.all.forwarding=1
net.ipv4.conf.default.forwarding=1
net.ipv4.conf.all.route_localnet=1

net.ipv6.conf.all.forwarding=1
net.ipv6.conf.default.forwarding=1
net.ipv6.conf.all.accept_ra = 2
```

随后应用：

```toml
sysctl -p
```


## iptables 持久化

如果一切顺利的话子网设备已经能够正常上网了，但此时 iptables 路由表并未持久化，重启路由器后路由表会丢失，因此我们安装 `iptables-persistent` 完成持久化的工作

```toml
sudo apt install iptables-persistent
```

默认应该会在安装时自动持久化当前配置，但倘若已经安装好后再更新配置，则可执行以下命令完成持久化：

```toml
netfilter-persistent save
```

持久化的路由表文件保存在以下位置：

```toml
/etc/iptables/rules.v4
/etc/iptables/rules.v6
```


# 开组局域网！

我在学校放了一台机器，里面跑了些自己使用的服务 & 一个 MineCraft 服务器，在之前尝试的时候随机测试的几个端口都是不通的，遂猜测校内的防火墙把全端口都屏蔽了入站。


为了能够连接到学校里的机器，之前一直使用的方案都是 tailscale

但使用下来发现校园网上下对等 1000 Mbps + 家里下行 1000Mbps/上行 50Mbps 使用 tailscale 连接最终速度只有可怜的 20 Mbps，虽然从延迟推断是成功直连了，但速度确实上不去，而且尝试下载东西时经常会出现下载一会就突然没速度了，尝试 ping 服务器也没有响应，要等待好一会才能恢复。其体验不能说十分完美，只能说勉强应急。


幸运的是，途中探测校园网 ipv6 的端口开放情况时偶然发现 udp 的端口是通，且随机测了几个都能联通，于是换 wireguard 走 ipv6/udp 直连，但最终也是差不多的速度。


既然 udp 是通的，那理论上我只需要使用某种神秘的走 udp 的协议即可打通两地的网络，但除了 wireguard，还有什么方案呢？突然有天我灵机一动，可以把某些~~用来干坏事的~~代理协议来组建我的大局域网，而支持 udp 协议的我首先想到的便是 hysteria2。于是，我在校内的机器上部署了一个 hysteria2 的服务端，尝试连接发现可用！考虑到其他设备的网络需求，于是决定立即下单一台 N100 的 mini 主机做路由！

在新搞来一台小主机做路由以后，然而许久未尝试用常规 Linux 系统充当网关，其配置过程痛苦无比（其实就是上面几步），在一切跑通之后我才下定决定将其记录下来以备后用，至于卡我最多的地方，是 NAT6 的配置，以及 iptables 的设置。现在回顾，只会感叹一句：我是网络白痴！


言归正传，为了支持 hysteria2，这里的路由服务我选择了 [dae](https://github.com/daeuniverse/dae)，同时配合 webui [daed](https://github.com/daeuniverse/daed) 使用，具体安装步骤参考 daed 的文档即可，安装完成后便是配置节点和路由，节点直接使用我校内的机器开的 hysteria2 服务，路由则将校内使用到的局域网段走校内的 hysteria，其他流量酌情配置。


最终测速能到 500 Mbps 左右：

![IPv4 测速](/images/1b5ee322c8a3b44a5507bb59.png)![IPv6 测速](/images/9749c8d64af74bf8fc3fb19e.png)

实际尝试从校内的机器下载内容能跑到 800 Mbps：
![下载速度能到 100 Mib/s](/images/bb2793df5c91250f092009f0.png)


# References


1. 软路由系列–路由器系统-Ubuntu <https://zhaowang.me/archives/soft-router-system-ubuntu/>
2. 使用iptables将ubuntu配置为路由器 <https://zu1k.com/posts/linux/ubuntu-iptables-nat/>
3. Nat6的实现 <https://ssstttar.com/posts/Z-turn/Nat6>
4. …
