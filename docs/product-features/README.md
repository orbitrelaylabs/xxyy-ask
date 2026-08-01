# XXYY 完整知识库

本目录以 https://docs.xxyy.io/ 为 XXYY 官方文档唯一来源，以 https://x.com/useXXYYio 为官方 X 更新唯一来源；客服群知识目录当前留空，只接收后续人工审核发布的聊天知识。

## 覆盖范围

- 中文站：72 个页面。
- 英文站：63 个页面。
- 官网合计：135 个页面，包含产品功能、API、Telegram 支持、功能更新、用户条款、隐私协议及英文文档。
- 官网媒体：89 个图片资产已下载到 `assets/`，页面中的 GitBook 文件引用已改写为本地 `/assets/` 路径；OCR 覆盖状态见 `enriched/media/manifest.json`。
- 视频本身的字幕、音频转写、关键帧 OCR 状态，以及正文对视频知识的覆盖等级和证据 SHA，见 `enriched/videos/manifest.json`；`docs:audit` 会区分“视频未转写”和“知识确实缺失”。
- 知识来源在入库时固定分类为 `official_docs`、`x_updates` 或 `admin_verified`；外部 GitHub 参考资料不进入正式知识库。

## 文件

- `pages/`：官网全量页面及额外客服知识，每页一个 Markdown 文件。
- `manifest.jsonl`：页面来源、语言、模块、更新时间和本地文件映射。
- `assets/xxyy-docs-assets.json`：官网图片资产的校验值及来源页面。
- `external/`：历史外部参考资料，仅归档，不进入正式知识库。
- `enriched/media/`：图片 OCR sidecar 与逐资产状态清单。
- `enriched/videos/`：视频字幕、音频转写或关键帧 OCR sidecar，以及视频提取/正文知识覆盖双维度状态清单。
- `enriched/reviewed/`：从官网内容派生并经人工校正的官方文档兜底。
- `admin-verified/`：XXYY 客服群审核知识；当前为空，未来只写入通过人工审核和发布门禁的聊天知识。
- 媒体 sidecar 会把原始图片或视频地址写入 chunk 元数据；检索命中解析文字时可同步返回对应媒体。
- `xxyy-product-functions.md`：历史中文产品功能聚合归档；仅在 `pages/` 没有可入库页面时作为兼容兜底，不与逐页官网文档重复入库。
- `xxyy-x-updates.md`：官方 X 历史更新聚合。
- `sources/usexxyyio-x-posts.jsonl`：官方 X 帖子逐条原始数据。

## 同步与入库

```bash
pnpm docs:sync
pnpm docs:enrich:media
pnpm docs:audit
pnpm rag:ingest
```

官网同步以中英文 sitemap 为准，保留带 `xxyy-ask:curated-*` 标记且来源 URL 属于官网或官方 X 的补充页面。`app:dev -- --full-sync` 会依次执行官网同步、媒体 enrichment、审计、X 全量抓取和正式 ingest。

## 中文页面

- [欢迎使用XXYY](pages/01-welcome.md) - https://docs.xxyy.io
- [新手必看](pages/02-readme__quickstart.md) - https://docs.xxyy.io/readme/quickstart
- [连接钱包](pages/03-readme__publish-your-docs.md) - https://docs.xxyy.io/readme/publish-your-docs
- [生成交易钱包](pages/04-readme__sheng-cheng-jiao-yi-qian-bao.md) - https://docs.xxyy.io/readme/sheng-cheng-jiao-yi-qian-bao
- [多语言](pages/05-readme__duo-yu-yan.md) - https://docs.xxyy.io/readme/duo-yu-yan
- [移动端登录](pages/06-readme__yi-dong-duan-deng-lu.md) - https://docs.xxyy.io/readme/yi-dong-duan-deng-lu
- [邀请朋友](pages/07-readme__yao-qing-peng-you.md) - https://docs.xxyy.io/readme/yao-qing-peng-you
- [交易代币](pages/08-getting-started__jiao-yi-dai-bi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi
- [Swap 交易](pages/09-getting-started__jiao-yi-dai-bi__swap-jiao-yi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/swap-jiao-yi
- [挂单交易](pages/10-getting-started__jiao-yi-dai-bi__gua-dan-jiao-yi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/gua-dan-jiao-yi
- [自动交易](pages/11-getting-started__jiao-yi-dai-bi__zi-dong-jiao-yi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/zi-dong-jiao-yi
- [跟随Dev卖100%](pages/12-getting-started__jiao-yi-dai-bi__zi-dong-jiao-yi__gen-sui-dev-mai-100.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/zi-dong-jiao-yi/gen-sui-dev-mai-100
- [开盘狙击](pages/13-getting-started__jiao-yi-dai-bi__zi-dong-jiao-yi__kai-pan-ju-ji.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/zi-dong-jiao-yi/kai-pan-ju-ji
- [Raydium自动卖](pages/14-getting-started__jiao-yi-dai-bi__zi-dong-jiao-yi__raydium-zi-dong-mai.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/zi-dong-jiao-yi/raydium-zi-dong-mai
- [交易模式](pages/15-getting-started__jiao-yi-dai-bi__jiao-yi-mo-shi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/jiao-yi-mo-shi
- [Degen](pages/16-getting-started__jiao-yi-dai-bi__jiao-yi-mo-shi__degen.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/jiao-yi-mo-shi/degen
- [极速模式](pages/17-getting-started__jiao-yi-dai-bi__jiao-yi-mo-shi__ji-su-mo-shi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/jiao-yi-mo-shi/ji-su-mo-shi
- [防夹模式](pages/18-getting-started__jiao-yi-dai-bi__jiao-yi-mo-shi__fang-jia-mo-shi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/jiao-yi-mo-shi/fang-jia-mo-shi
- [交易设置](pages/19-getting-started__jiao-yi-dai-bi__jiao-yi-she-zhi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/jiao-yi-she-zhi
- [快捷交易](pages/20-getting-started__kuai-jie-jiao-yi.md) - https://docs.xxyy.io/getting-started/kuai-jie-jiao-yi
- [发现](pages/21-getting-started__fa-xian.md) - https://docs.xxyy.io/getting-started/fa-xian
- [收藏](pages/22-getting-started__fa-xian__shou-cang.md) - https://docs.xxyy.io/getting-started/fa-xian/shou-cang
- [Pump](pages/23-getting-started__fa-xian__pump.md) - https://docs.xxyy.io/getting-started/fa-xian/pump
- [趋势](pages/24-getting-started__fa-xian__qu-shi.md) - https://docs.xxyy.io/getting-started/fa-xian/qu-shi
- [Pump 早鸟信号](pages/26-getting-started__fa-xian__pump-zao-niao-xin-hao.md) - https://docs.xxyy.io/getting-started/fa-xian/pump-zao-niao-xin-hao
- [Pump 即将打满](pages/27-getting-started__fa-xian__pump-ji-jiang-da-man.md) - https://docs.xxyy.io/getting-started/fa-xian/pump-ji-jiang-da-man
- [Pump 正在迁移](pages/28-getting-started__fa-xian__pump-zheng-zai-qian-yi.md) - https://docs.xxyy.io/getting-started/fa-xian/pump-zheng-zai-qian-yi
- [Dexs-AD](pages/29-getting-started__fa-xian__dexs-ad.md) - https://docs.xxyy.io/getting-started/fa-xian/dexs-ad
- [Moonshot 新币](pages/30-getting-started__fa-xian__moonshot-xin-bi.md) - https://docs.xxyy.io/getting-started/fa-xian/moonshot-xin-bi
- [搜索](pages/31-getting-started__sou-suo.md) - https://docs.xxyy.io/getting-started/sou-suo
- [K 线区域](pages/32-getting-started__k-xian-qu-yu.md) - https://docs.xxyy.io/getting-started/k-xian-qu-yu
- [K 线时间区间选择](pages/33-getting-started__k-xian-qu-yu__k-xian-shi-jian-qu-jian-xuan-ze.md) - https://docs.xxyy.io/getting-started/k-xian-qu-yu/k-xian-shi-jian-qu-jian-xuan-ze
- [价格市值切换](pages/34-getting-started__k-xian-qu-yu__jia-ge-shi-zhi-qie-huan.md) - https://docs.xxyy.io/getting-started/k-xian-qu-yu/jia-ge-shi-zhi-qie-huan
- [K 线交易标记](pages/35-getting-started__k-xian-qu-yu__k-xian-jiao-yi-biao-ji.md) - https://docs.xxyy.io/getting-started/k-xian-qu-yu/k-xian-jiao-yi-biao-ji
- [平均买入成本线](pages/36-getting-started__k-xian-qu-yu__ping-jun-mai-ru-cheng-ben-xian.md) - https://docs.xxyy.io/getting-started/k-xian-qu-yu/ping-jun-mai-ru-cheng-ben-xian
- [代币信息区](pages/37-getting-started__dai-bi-xin-xi-qu.md) - https://docs.xxyy.io/getting-started/dai-bi-xin-xi-qu
- [Dashboard](pages/38-getting-started__dashboard.md) - https://docs.xxyy.io/getting-started/dashboard
- [收益统计](pages/39-getting-started__dashboard__shou-yi-tong-ji.md) - https://docs.xxyy.io/getting-started/dashboard/shou-yi-tong-ji
- [持仓管理](pages/40-getting-started__dashboard__chi-cang-guan-li.md) - https://docs.xxyy.io/getting-started/dashboard/chi-cang-guan-li
- [最新成交](pages/41-getting-started__dashboard__zui-xin-cheng-jiao.md) - https://docs.xxyy.io/getting-started/dashboard/zui-xin-cheng-jiao
- [Holders](pages/42-getting-started__dashboard__holders.md) - https://docs.xxyy.io/getting-started/dashboard/holders
- [Holder](pages/43-getting-started__dashboard__holders__holder.md) - https://docs.xxyy.io/getting-started/dashboard/holders/holder
- [TagHolder](pages/44-getting-started__dashboard__holders__tagholder.md) - https://docs.xxyy.io/getting-started/dashboard/holders/tagholder
- [标识说明](pages/45-getting-started__dashboard__holders__biao-shi-shuo-ming.md) - https://docs.xxyy.io/getting-started/dashboard/holders/biao-shi-shuo-ming
- [订单管理](pages/46-getting-started__dashboard__ding-dan-guan-li.md) - https://docs.xxyy.io/getting-started/dashboard/ding-dan-guan-li
- [监控管理](pages/47-getting-started__dashboard__jian-kong-guan-li.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li
- [关注钱包设置](pages/48-getting-started__dashboard__jian-kong-guan-li__guan-zhu-qian-bao-she-zhi.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/guan-zhu-qian-bao-she-zhi
- [批量导入设置](pages/49-getting-started__dashboard__jian-kong-guan-li__pi-liang-dao-ru-she-zhi.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/pi-liang-dao-ru-she-zhi
- [导出钱包](pages/50-getting-started__dashboard__jian-kong-guan-li__dao-chu-qian-bao.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/dao-chu-qian-bao
- [设置 TG通知](pages/51-getting-started__dashboard__jian-kong-guan-li__telegram-wallet-monitoring-configuration-guide.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/telegram-wallet-monitoring-configuration-guide
- [钱包分组](pages/52-getting-started__dashboard__jian-kong-guan-li__qian-bao-fen-zu.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/qian-bao-fen-zu
- [列表操作](pages/53-getting-started__dashboard__jian-kong-guan-li__lie-biao-cao-zuo.md) - https://docs.xxyy.io/getting-started/dashboard/jian-kong-guan-li/lie-biao-cao-zuo
- [扫链页面](pages/54-getting-started__sao-lian-ye-mian.md) - https://docs.xxyy.io/getting-started/sao-lian-ye-mian
- [扫链筛选](pages/55-getting-started__sao-lian-ye-mian__sao-lian-shai-xuan.md) - https://docs.xxyy.io/getting-started/sao-lian-ye-mian/sao-lian-shai-xuan
- [打满 Alert](pages/56-getting-started__sao-lian-ye-mian__da-man-alert.md) - https://docs.xxyy.io/getting-started/sao-lian-ye-mian/da-man-alert
- [持仓盈亏](pages/57-getting-started__chi-cang-ying-kui.md) - https://docs.xxyy.io/getting-started/chi-cang-ying-kui
- [钱包管理](pages/58-getting-started__qian-bao-guan-li.md) - https://docs.xxyy.io/getting-started/qian-bao-guan-li
- [XXYY Pro 权益](pages/59-getting-started__xxyy-pro-quan-yi.md) - https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi
- [Basic](pages/60-getting-started__xxyy-pro-quan-yi__basic.md) - https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi/basic
- [Pro](pages/61-getting-started__xxyy-pro-quan-yi__pro.md) - https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi/pro
- [永久PRO](pages/62-getting-started__xxyy-pro-quan-yi__yong-jiu-pro.md) - https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi/yong-jiu-pro
- [如何升级为 Pro](pages/63-getting-started__xxyy-pro-quan-yi__ru-he-sheng-ji-wei-pro.md) - https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi/ru-he-sheng-ji-wei-pro
- [XXYY API 参考文档](pages/66-xxyy-api-can-kao-wen-dang.md) - https://docs.xxyy.io/xxyy-api-can-kao-wen-dang
- [Telegram 官方答疑群](pages/67-telegram-guan-fang-da-yi-qun.md) - https://docs.xxyy.io/telegram-guan-fang-da-yi-qun
- [功能更新](pages/68-changelog.md) - https://docs.xxyy.io/changelog
- [XXYY 用户条款](pages/69-wang-zhan-xie-yi__xxyy-yong-hu-tiao-kuan.md) - https://docs.xxyy.io/wang-zhan-xie-yi/xxyy-yong-hu-tiao-kuan
- [XXYY 隐私协议](pages/70-wang-zhan-xie-yi__xxyy-yin-si-xie-yi.md) - https://docs.xxyy.io/wang-zhan-xie-yi/xxyy-yin-si-xie-yi
- [快捷交易](pages/134-getting-started__jiao-yi-dai-bi__kuai-jie-jiao-yi.md) - https://docs.xxyy.io/getting-started/jiao-yi-dai-bi/kuai-jie-jiao-yi
- [KOL买入& Tagholder买入](pages/135-getting-started__fa-xian__kol-mai-ru-tagholder-mai-ru.md) - https://docs.xxyy.io/getting-started/fa-xian/kol-mai-ru-tagholder-mai-ru
- [钱包监控](pages/136-getting-started__qian-bao-jian-kong.md) - https://docs.xxyy.io/getting-started/qian-bao-jian-kong
- [监控策略管理](pages/137-getting-started__jian-kong-ce-le-guan-li.md) - https://docs.xxyy.io/getting-started/jian-kong-ce-le-guan-li
- [跟单](pages/138-getting-started__gen-dan.md) - https://docs.xxyy.io/getting-started/gen-dan

## English pages

- [Page Not Found](pages/71-en.md) - https://docs.xxyy.io/en
- [A Must-Read for Beginners](pages/72-en__readme__a-must-read-for-beginners.md) - https://docs.xxyy.io/en/readme/a-must-read-for-beginners
- [Connect Wallet](pages/73-en__readme__connect-wallet.md) - https://docs.xxyy.io/en/readme/connect-wallet
- [Generate Your Trading Wallet](pages/74-en__readme__generate-your-trading-wallet.md) - https://docs.xxyy.io/en/readme/generate-your-trading-wallet
- [Language Selection](pages/75-en__readme__language-selection.md) - https://docs.xxyy.io/en/readme/language-selection
- [Mobile Device Login](pages/76-en__readme__mobile-device-login.md) - https://docs.xxyy.io/en/readme/mobile-device-login
- [Referral Program](pages/77-en__readme__referral-program.md) - https://docs.xxyy.io/en/readme/referral-program
- [Trading on XXYY](pages/78-en__trading-on-xxyy.md) - https://docs.xxyy.io/en/trading-on-xxyy
- [Trading Tokens](pages/79-en__trading-tokens.md) - https://docs.xxyy.io/en/trading-tokens
- [Swap](pages/80-en__trading-tokens__swap.md) - https://docs.xxyy.io/en/trading-tokens/swap
- [Limit Orders](pages/81-en__trading-tokens__limit-orders.md) - https://docs.xxyy.io/en/trading-tokens/limit-orders
- [Automated Trading](pages/82-en__trading-tokens__automated-trading.md) - https://docs.xxyy.io/en/trading-tokens/automated-trading
- [Follow Dev Sell 100%](pages/83-en__trading-tokens__automated-trading__follow-dev-sell-100.md) - https://docs.xxyy.io/en/trading-tokens/automated-trading/follow-dev-sell-100
- [Snipe](pages/84-en__trading-tokens__automated-trading__snipe.md) - https://docs.xxyy.io/en/trading-tokens/automated-trading/snipe
- [Graduated Sell](pages/85-en__trading-tokens__automated-trading__graduated-sell.md) - https://docs.xxyy.io/en/trading-tokens/automated-trading/graduated-sell
- [Trading Mode](pages/86-en__trading-tokens__trading-mode.md) - https://docs.xxyy.io/en/trading-tokens/trading-mode
- [Degen](pages/87-en__trading-tokens__trading-mode__degen.md) - https://docs.xxyy.io/en/trading-tokens/trading-mode/degen
- [Turbo](pages/88-en__trading-tokens__trading-mode__turbo.md) - https://docs.xxyy.io/en/trading-tokens/trading-mode/turbo
- [Anti-MEV Mode](pages/89-en__trading-tokens__trading-mode__anti-mev-mode.md) - https://docs.xxyy.io/en/trading-tokens/trading-mode/anti-mev-mode
- [Trading Settings](pages/90-en__trading-tokens__trading-settings.md) - https://docs.xxyy.io/en/trading-tokens/trading-settings
- [Quick Trading](pages/91-en__quick-trading.md) - https://docs.xxyy.io/en/quick-trading
- [Trades](pages/92-en__trades.md) - https://docs.xxyy.io/en/trades
- [Watchlist](pages/93-en__trades__watchlist.md) - https://docs.xxyy.io/en/trades/watchlist
- [New Pairs](pages/94-en__trades__new-pairs.md) - https://docs.xxyy.io/en/trades/new-pairs
- [Trending](pages/95-en__trades__trending.md) - https://docs.xxyy.io/en/trades/trending
- [Monitor](pages/96-en__trades__monitor.md) - https://docs.xxyy.io/en/trades/monitor
- [Final Stretch](pages/97-en__trades__final-stretch.md) - https://docs.xxyy.io/en/trades/final-stretch
- [Migrated](pages/98-en__trades__migrated.md) - https://docs.xxyy.io/en/trades/migrated
- [DEXs-AD](pages/99-en__trades__dexs-ad.md) - https://docs.xxyy.io/en/trades/dexs-ad
- [Search](pages/100-en__search.md) - https://docs.xxyy.io/en/search
- [Chart Area](pages/101-en__chart-area.md) - https://docs.xxyy.io/en/chart-area
- [Selecting Chart Timeframes](pages/102-en__chart-area__selecting-chart-timeframes.md) - https://docs.xxyy.io/en/chart-area/selecting-chart-timeframes
- [Toggling Between Price and Market Cap](pages/103-en__chart-area__toggling-between-price-and-market-cap.md) - https://docs.xxyy.io/en/chart-area/toggling-between-price-and-market-cap
- [On-Chart Transaction Markers](pages/104-en__chart-area__on-chart-transaction-markers.md) - https://docs.xxyy.io/en/chart-area/on-chart-transaction-markers
- [Avg. Price Line](pages/105-en__chart-area__avg-price-line.md) - https://docs.xxyy.io/en/chart-area/avg.-price-line
- [Token Information](pages/106-en__token-information.md) - https://docs.xxyy.io/en/token-information
- [Dashboard](pages/107-en__dashboard.md) - https://docs.xxyy.io/en/dashboard
- [My trades](pages/108-en__dashboard__my-trades.md) - https://docs.xxyy.io/en/dashboard/my-trades
- [Holdings](pages/109-en__dashboard__holdings.md) - https://docs.xxyy.io/en/dashboard/holdings
- [Transactions](pages/110-en__dashboard__transactions.md) - https://docs.xxyy.io/en/dashboard/transactions
- [Holders](pages/111-en__dashboard__holders.md) - https://docs.xxyy.io/en/dashboard/holders
- [Holder](pages/112-en__dashboard__holders__holder.md) - https://docs.xxyy.io/en/dashboard/holders/holder
- [TagHolder](pages/113-en__dashboard__holders__tagholder.md) - https://docs.xxyy.io/en/dashboard/holders/tagholder
- [Wallet Tag Descriptions](pages/114-en__dashboard__holders__wallet-tag-descriptions.md) - https://docs.xxyy.io/en/dashboard/holders/wallet-tag-descriptions
- [Orders](pages/115-en__orders.md) - https://docs.xxyy.io/en/orders
- [Monitor](pages/116-en__monitor.md) - https://docs.xxyy.io/en/monitor
- [Monitor Wallet Settings](pages/117-en__monitor__monitor-wallet-settings.md) - https://docs.xxyy.io/en/monitor/monitor-wallet-settings
- [Bulk Import](pages/118-en__monitor__bulk-import.md) - https://docs.xxyy.io/en/monitor/bulk-import
- [Export Wallets](pages/119-en__monitor__export-wallets.md) - https://docs.xxyy.io/en/monitor/export-wallets
- [Setting Up Telegram Notifications](pages/120-en__monitor__setting-up-telegram-notifications.md) - https://docs.xxyy.io/en/monitor/setting-up-telegram-notifications
- [Actions](pages/121-en__monitor__actions.md) - https://docs.xxyy.io/en/monitor/actions
- [Meme](pages/122-en__meme.md) - https://docs.xxyy.io/en/meme
- [Filter](pages/123-en__meme__filter.md) - https://docs.xxyy.io/en/meme/filter
- [Wallet Management](pages/124-en__wallet-management.md) - https://docs.xxyy.io/en/wallet-management
- [XXYY Pro Membership](pages/125-en__xxyy-pro-membership.md) - https://docs.xxyy.io/en/xxyy-pro-membership
- [Basic](pages/126-en__xxyy-pro-membership__basic.md) - https://docs.xxyy.io/en/xxyy-pro-membership/basic
- [Pro](pages/127-en__xxyy-pro-membership__pro.md) - https://docs.xxyy.io/en/xxyy-pro-membership/pro
- [Elite Pro](pages/128-en__xxyy-pro-membership__elite-pro.md) - https://docs.xxyy.io/en/xxyy-pro-membership/elite-pro
- [How to Upgrade to Pro](pages/129-en__xxyy-pro-membership__how-to-upgrade-to-pro.md) - https://docs.xxyy.io/en/xxyy-pro-membership/how-to-upgrade-to-pro
- [Telegram Support Group](pages/130-en__telegram-support-group.md) - https://docs.xxyy.io/en/telegram-support-group
- [Feature Updates](pages/131-en__feature-updates.md) - https://docs.xxyy.io/en/feature-updates
- [XXYY Terms of Use](pages/132-en__xxyy-terms__xxyy-terms-of-use.md) - https://docs.xxyy.io/en/xxyy-terms/xxyy-terms-of-use
- [XXYY Privacy Policy](pages/133-en__xxyy-terms__xxyy-privacy-policy.md) - https://docs.xxyy.io/en/xxyy-terms/xxyy-privacy-policy

## 额外知识页面

- [XXYY 当前支持的产品功能总览](pages/00-current-capability-overview.md) - https://docs.xxyy.io
- [移动端桌面入口](pages/64-getting-started__mobile-app.md) - https://docs.xxyy.io/readme/yi-dong-duan-deng-lu
- [Robinhood Chain 支持范围](pages/65-current-support__robinhood-chain.md) - https://x.com/useXXYYio/status/2075547879876554811
