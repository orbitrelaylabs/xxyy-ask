---
title: "跟单"
source_url: "https://docs.xxyy.io/getting-started/gen-dan"
source_markdown_url: "https://docs.xxyy.io/getting-started/gen-dan.md"
language: "zh"
category: "中文产品文档"
section: "产品文档"
lastmod: "2026-07-31T07:22:45.029Z"
retrieved_at: "2026-08-01T04:12:35.773Z"
content_state: "content"
ingest: true
---

# 跟单

### 跟单说明

跟单功能可实时镜像目标钱包的买入与卖出操作

支持5大公链，SOL BSC Base ETH Robinhood

每个跟单任务都支持独立设置参数

#### 跟单入口

4个地方可以进：

1. 顶部菜单栏点 跟单    → 直接进入跟单管理页面新增跟单任务

<img src="/assets/xxyy-docs-sa0ofU6Q0bMWhoeke7pW.png" alt="" height="96" width="602">

2. 顶部菜单栏点 监控    → 选择自己已监控的钱包点  跟单

<img src="/assets/xxyy-docs-Lw1OP8kyK3YM6a65Se02.png" alt="" height="123" width="602">

3. 个人地址收益页面        → 交易详情界面点击任意地址跳转到个人地址收益界面点击跟单

<img src="/assets/xxyy-docs-h52zNtPtUsH2wqBzHfFy.png" alt="" height="197" width="602">

<img src="/assets/xxyy-docs-AIQPPvvVp0lNSuHYjxyu.png" alt="" height="264" width="602">

4. &#x20;地址搜索结果快捷跟单

<img src="/assets/xxyy-docs-SiFYNC1wUMXIDATqutNT.png" alt="" height="324" width="602">

#### <br>

#### 跟单参数设置

在任意跟单入口点击跟单开始设置跟单参数<br>

第一步：选钱包

选择扣款钱包：从你的钱包列表中选择一个用于支付跟单买入金额及交易手续费的账户，选择要跟的钱包地址。

<img src="/assets/xxyy-docs-YPlOpf2oZihYmIKnKddR.png" alt="" height="212" width="585">

第二步：设置买入方式

* 按固定金额买入：每次跟单买固定的SOL金额
* 按固定比例买入：按目标钱包买入金额的比例跟买，可以自定义最大买入金额进行限制

<img src="/assets/xxyy-docs-yKMjnHsoSyzFE6c5Hnqy.png" alt="" height="221" width="579">

\
第三步：设置卖出方式

* 跟单卖出：目标钱包卖，你就跟着卖
* 不跟单卖出：不自动卖，自己手动处理
* 一次性卖出全部持仓：一键清仓

<img src="/assets/xxyy-docs-w128rYToLCcQu5034G78.png" alt="" height="189" width="569">

第四步：高级配置

| 功能            | 说明            |
| ------------- | ------------- |
| 单币最大买入次数      | 输入单个代币跟单买入次数  |
| 代币创建时间（最小/最大） | 限制代币创建时间范围    |
| 市值（最小/最大）     | 代币市值在区间内才跟买   |
| 持有者（最小/最大）    | 持币地址数在区间内才跟买  |
| 流动性（最小/最大）    | 池子大小在区间内才跟买   |
| 跟单买入金额（最小/最大） | 限制跟单地址的买入金额范围 |

<img src="/assets/xxyy-docs-TtqfefdBBCFA6uZ7r8MI.png" alt="" height="361" width="602">

第五步：交易设置

* 防夹（可以选基础/进阶/强化）
* 交易模式：Degen / 极速 / 防夹 / 基础
* 滑点（自动/自定义）：自动或手动设置滑点百分比
* 交易Fee：设置优先费（SOL）

确认无误后，点击 创建跟单。

<img src="/assets/xxyy-docs-RHYJXj6Z2yNPAHbF8zVS.png" alt="" height="224" width="602">

<br>

### **管理跟单任务**

在  跟单 页面可以：

* 查看所有跟单任务的总利润、总买入、总卖出、跟单交易代币数及最近交易记录
* 全部暂停 / 全部关闭，批量管理跟单任务
* 每个跟单任务右侧有 操作 按钮，可单独管理（暂停/开启、修改、关闭）
* 点击跟单订单可查看跟单明细：跟单钱包地址（支持复制/修改备注）、交易钱包地址及余额、总利润/已实现利润/未实现利润、买卖金额及笔数、持仓代币数、跟单状态
* 跟单交易明细按时间倒序展示：跟单类型（买入/卖出）、代币（点击跳转详情）、交易金额（SOL/USD切换）、价格/市值、交易时间、交易状态（成功/失败，失败展示原因），支持在区块链浏览器查看自己交易和被跟单钱包交易

<br>

\ <br>
