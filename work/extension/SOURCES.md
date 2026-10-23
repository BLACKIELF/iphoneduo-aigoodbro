# iPhoneduo助手aigoodbro · 来源与修改说明

版本：1018v1（Chrome 内部版本 1.5.0，预发布测试版）
修改日期：2026-10-18
官网：[aigoodbro.com](https://aigoodbro.com)

## 来源

- Sunbelife/apple-store-helper-15，提交 `1f83f0f6d54b4382c18df6ac68ab2ce4acf6942f`，浏览器扩展 1.9.1。复用商品与门店数据、型号选择和库存配置流程。
  https://github.com/Sunbelife/apple-store-helper-15
- Sunbelife 新增参考提交 `4ad7876a8e1419578de195208c10140376495dba`（2026-10-17）：适配大陆合法邮编仅使用 location、非法邮编回退 store 的参数策略，以及受限门店不覆盖未查询门店结果的隔离语义。Java/JS 均仍严格匹配目标门店与 SKU，不直接采纳邻店库存；不复制上游反检测或认证处理。
  https://github.com/Sunbelife/apple-store-helper-15/blob/4ad7876a8e1419578de195208c10140376495dba/services/apple_urls.go
- MoshiCoCo/Apple-Monitor，提交 `fda1c24d20f269ef4fbd01ff37001d056385d66f`，v0.1.5。移植飞书/Lark 文本通知与可选签名协议，并采用其现代门店库存查询接口。
  https://github.com/MoshiCoCo/Apple-Monitor
- suversal/apple-store-inventory-monitor，提交 `7f9e86d642e9b662e7a4bc9ecc156bbd43f070f9`，GPL-3.0-or-later。依据 checkout.rs 与 checkout_pickup_region.js 移植自提履约、省市区、唯一门店、最早可用日期/时段、已有联系人非空核验、支付宝与订单确认操作，保留此前的购物袋行与总金额选择器。适配至本项目 MV3 内容脚本和单次提交状态机，没有引入 CDP 执行器、反检测或身份资料存储。
  https://github.com/suversal/apple-store-inventory-monitor/blob/7f9e86d642e9b662e7a4bc9ecc156bbd43f070f9/src-tauri/src/checkout.rs

- Apple 中国大陆 iPhone 17 商品页（2026-10-16读取）：仅新增已核验的512GB青雾蓝色MG744CH/A，公开标价¥8,799不代表库存或最终结账价格。
  https://www.apple.com.cn/shop/buy-iphone/iphone-17/mg744ch/a

## 本地融合修改

- Manifest V3扩展负责配置与状态展示，Java 21独立服务负责库存查询和通知，关闭Chrome后继续运行。
- Native Messaging连接固定扩展ID与本机服务；只监听127.0.0.1，使用本地配对凭据，拒绝网页Origin和非本机Host。
- Java使用JDK标准库重写，不引入上游Spring/Maven运行依赖；移植Bark、飞书/Lark通知协议及可选HMAC签名。
- 30秒、1分钟、2分钟、5分钟检查间隔；现代pickup-message接口，精确匹配门店和SKU，不把未知状态判成无货。
- 503/429按60、120、240、300秒逐步延长等待后重试，界面显示等待重试；故障不误报库存状态，不代表官网接口已经恢复。
- 状态持久化、暂停取消在途操作、逐渠道去重和有限重试；配置失败不显示已保存，后台离线时明确显示未知状态。
- 保留7地区数据和大陆Duo 8个内置编号，编号不代表有货。
- 不读取或写入Apple认证Cookie，不绕过验证码。1016v3另增本地自动选配、加购、结账及单次生成未付款订单模块，付款步骤停止；尚未完成实站验收。
- 基于1016v1已受限改写的Sunbelife查询桥，新增显式单次官网页库存查询；只作用于已打开的大陆官网商品页，不自动打开交易页或处理验证。结果独立于Java库存及购买状态，不能触发提交订单。未恢复旧库存引擎的自动导航、Cookie清除或验证函数调用。
- 1016v8 增加仅购物袋入口、强制试跑到确认页、自提门店最终核验和 Java 新鲜库存单次触发。触发要求已授权等待、准确任务/门店/SKU、启用监控、非未来且60秒内的有货结果；先持久化消费标记，再打开购物袋。停止监控或修改任务取消等待。Chrome 运行时每30秒读取本机后台状态，不增加 Apple 请求；官网页手动查询不触发购买。
- 2026-10-16 修改者 AiGoodBro：将上游自提步骤改为每步唯一控件及防重检查；区县须明确匹配公开门店地址，缺失资料和确认页门店证据停止。邮寄、预算、单件、防重复提交和付款停止边界保留。实际官网自动下单尚未验收。
- 1016v9 修复取消与恢复竞态、过期库存触发、库存闹钟同步和提交中断恢复；强化日期/时段、必填表单、跨行门店摘要与付款方式冲突校验。暂停可中断正在等待的购买启动，晚到响应不能重新启动；Java 后台实现与运行配置不变。

- 1018v1 / 2026-10-18 修改者 AiGoodBro：同步大陆邮编参数与门店结果隔离；重复目标门店保持未知。新增 GitHub 公开版本检测、24小时缓存、手动检查、更新口令与升级提示，保持失败和未知明确区分，不新增权限或依赖。复核 suversal 新提交 `363601e33e0354907242ac8677680ee73b971e37` 后未移植其持续重试及自动清袋流程；本项目仍只允许单次授权提交。

## 许可证

融合版按 GPL-3.0 提供；完整文本见 `LICENSE` 与 `licenses/Sunbelife-LICENSE`。Apple-Monitor 的 MIT 声明见 `licenses/Apple-Monitor-LICENSE`，Copyright (c) 2022 Moshi。Suversal 及其前序项目的版权与来源声明见 `licenses/Suversal-NOTICE`，许可全文见 `licenses/Suversal-LICENSE`。适配源码随本仓库提供。

Sunbelife README 的 MIT 徽章与其实际 GPL-3.0 LICENSE 不一致，本地采用实际 LICENSE。Apple-Monitor README 另有用途声明，上游原文保存在源代码目录。公开仓库提供源码预发布版本，发布记录以 Git 提交为准。
