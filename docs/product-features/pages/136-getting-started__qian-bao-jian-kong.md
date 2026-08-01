---
title: "钱包监控"
source_url: "https://docs.xxyy.io/getting-started/qian-bao-jian-kong"
source_markdown_url: "https://docs.xxyy.io/getting-started/qian-bao-jian-kong.md"
language: "zh"
category: "中文产品文档"
section: "产品文档"
lastmod: "2026-07-31T07:22:45.029Z"
retrieved_at: "2026-08-01T03:57:23.002Z"
content_state: "content"
ingest: true
---

# 钱包监控

监控聪明钱包，第一时间发现链上异动。单链最高支持 5000 个钱包地址，大户、KOL、聪明钱一网打尽，从此不会错过任何关键动向。

监控入口

在顶部菜单栏点击监控进入监控管理

<img src="/assets/xxyy-docs-WRDmUZH9UK19ab4tbwhA.png" alt="" height="279" width="602">

#### &#x20;       一、添加监控钱包

&#x20;         三种添加方式：

&#x20;         1\. 手动添加\
&#x20;         在「监控」的「钱包监控」页面，点击「添加钱包」，填写钱包地址，设        置钱包名称、分组和监控参数。

&#x20;         2\. 批量导入\
&#x20;         支持 GMGN / Axiom / Photon / BullX 钱包格式直接粘贴导入，一行一个，支持逗号或空格分隔（格式：钱包地址,钱包名称,分组）。也支持上传文件批量导入

（5M以内）。

&#x20;        3\. 快捷添加\
&#x20;       在任意代币的交易详情页，点击地址右侧的 💗 小红心，即可将该地址一键加    入监控，无需手动复制填写。

####

#### 二、监控参数

<img src="/assets/xxyy-docs-BMCrI3lNPAcXdVdniEGw.png" alt="" height="436" width="358">

交易类型\
监控哪些行为：买入 / 卖出 / 发送SOL / 收到SOL / 发送Token / 收到Token

金额过滤

* 最小买入金额：低于此金额的买入不推送
* 最小卖出金额：低于此金额的卖出不推送

市值过滤

* 最小市值 / 最大市值（$）：只监控市值在设定区间内的代币

推送范围

* 仅推送外盘交易 / 仅推送内盘交易（两者互斥，不可同时勾选）
* 内盘支持选择具体平台

&#x20;        提示音设置\
&#x20;       网页内监控触发时播放提示音

* 买入提示音 / 卖出提示音 / 转账提示音 可单独设置
* 可选：无提示音 / 叮咚 / 金币 / 经典 / 马里奥

#### 三、Telegram 推送配置

配置 TG Bot 后，监控触发时自动推送消息到你的群或个人。

操作步骤

1. 点击  TG通知设置
2. 点击  创建TG Bot ，按指引创建 Bot 并获取 API Token
3. 将 API Token 填入配置页面，最多添加 5 个 Bot
4. 将创建的 Bot 拉入你的群聊，并设为管理员
5. 配置推送群聊，完成绑定

&#x20;       配置完成后，监控触发时自动推送。 若推送异常，检查 Bot 是否仍在群聊中且具有管理员权限。

<img src="/assets/xxyy-docs-NOkKrM8fJ8mQ4uLrsesq.png" alt="" height="357" width="528">

具体操作指南（跳转原xxyy使用说明的配置指南）

#### 四、列表管理

* 钱包分组：pump / 聪明钱 / evm监控 等，方便分类管理
* 钱包备注：自定义备注，方便识别
* 清空0余额地址：一键清理已无余额的钱包（清空后数据不可恢复，需二次确认）
* 批量删除：批量移除监控钱包

<img src="/assets/xxyy-docs-7s2hUjiBPJu9bem5p4P3.png" alt="" height="39" width="602">

<br>
