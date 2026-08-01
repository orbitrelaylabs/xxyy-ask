---
title: "设置 TG通知"
source_url: "https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/telegram-wallet-monitoring-configuration-guide"
source_markdown_url: "https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/telegram-wallet-monitoring-configuration-guide.md"
language: "zh"
category: "使用XXYY交易"
section: "Dashboard"
lastmod: "2025-10-24T09:17:54.613Z"
retrieved_at: "2026-08-01T04:12:35.773Z"
content_state: "content"
ingest: true
---

# 设置 TG通知

**重要提示：** 请使用官方bot <https://t.me/XXYYgetidBot>  谨防山寨bot造成资金损失。

#### 视频教程：

{% embed url="<https://www.youtube.com/watch?v=mzTSPHqP8UA>" %}

#### 第一步：创建 Telegram Group

1. 打开 Telegram，点击左上角菜单\
   ! 
2. 点击创建 group，设置 group 名称\ <img src="/assets/xxyy-docs-1eNDVwe6VD3KvXCpzXEC.png" alt="" data-size="original">
3. 在搜索框中输入 @XXYYgetidBot，选择带有官方标识的正版bot\
   ! 
4. 点击 create 创建 group\
   ! 
5. 将bot设置为管理员\
   ! \
   \
   ! \
   \
   ! \
   \
   ! 

#### 第二步：创建自己的 Bot

1. 访问 [BotFather](https://telegram.me/BotFather) 创建bot
2. 输入指令 /newbot<br>

   <figure><img src="/assets/xxyy-docs-VifNwwGl9JqeDkFQoomu.png" alt=""><figcaption></figcaption></figure>
3. 设置bot名称（作为备注使用）\
   ! 
4. 设置bot的唯一username\
   ! 
5. 保存系统返回的 token api\
   ! 
6. 将token配置到网页中，并将bot添加到group\
   ! 

\*提示：建议创建多个bot以避免官方限频。创建间隔可能需要等待几分钟。

#### 第三步：获取 Group ID

1. 在group中发送指令 /getgroupid\
   ! 
2. 注意保留返回ID中的负号（-）<br>

   <figure><img src="/assets/xxyy-docs-ASksaL8WCiyxMtRMVehE.png" alt=""><figcaption></figcaption></figure>
3. 如获取失败，请确保已将bot设置为管理员后重试
4. 将获取的ID配置到网页中<br>

   <figure><img src="/assets/xxyy-docs-oq6BgG0mCkrfKeaJQzCz.png" alt=""><figcaption></figcaption></figure>
5. 点击测试推送验证配置是否成功

<figure><img src="/assets/xxyy-docs-kho98IPJcOUVXIFjrxhA.png" alt=""><figcaption></figcaption></figure>

#### **注意事项：**

* 必须使用真实地址;
* 如无法收到推送，请检查group ID是否发生变化;
