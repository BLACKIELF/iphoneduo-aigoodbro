# 来源与修改说明

1016v6 / 1.3.0，2026-10-16。项目：iPhoneduo助手aigoodbro，官网 [aigoodbro.com](https://aigoodbro.com)。

## 来源

- [Sunbelife/apple-store-helper-15](https://github.com/Sunbelife/apple-store-helper-15)，提交 `1f83f0f6d54b4382c18df6ac68ab2ce4acf6942f`。复用商品、门店数据、图标和库存配置流程；官网页查询桥经过受限改写。实际 LICENSE 为 GPL-3.0，保留于 `licenses/Sunbelife-LICENSE`。
- [MoshiCoCo/Apple-Monitor](https://github.com/MoshiCoCo/Apple-Monitor)，提交 `fda1c24d20f269ef4fbd01ff37001d056385d66f`。采用现代门店查询接口，移植飞书/Lark 通知及可选签名协议。MIT 声明保留于 `licenses/Apple-Monitor-LICENSE`，Copyright (c) 2022 Moshi。
- [suversal/apple-store-inventory-monitor](https://github.com/suversal/apple-store-inventory-monitor/blob/7f9e86d642e9b662e7a4bc9ecc156bbd43f070f9/src-tauri/src/checkout.rs)，提交 `7f9e86d642e9b662e7a4bc9ecc156bbd43f070f9`，GPL-3.0-or-later。参考其 `bagtotalvalue`、数字编号购物袋行与可见错误选择器；没有移植 CDP 控制器、反检测或下单成功判定。
- [Apple 中国大陆公开商品页](https://www.apple.com.cn/shop/buy-iphone/iphone-17/mg744ch/a)，用于核对 iPhone 17 的 512GB 青雾蓝色 `MG744CH/A` 配置。目录或公开价格不代表当前库存及最终结账价格。

## 主要修改

- Manifest V3 扩展与 Java 21 本机服务分工，使用 Native Messaging 和本机配对凭据连接。Java 仅使用 JDK 标准库。
- 精确匹配门店与 SKU，未知库存保持未知；503/429 持久冷却、有限通知重试、暂停取消在途操作。
- 新增显式的单次官网页查询，限定已打开的中国大陆商品页、同源只读查询及严格响应过滤；不读取或修改 Apple Cookie，不清除验证状态，不执行验证函数。
- 实验性 iPhone 购买流程增加规格、购物袋数量、总价、明确选中付款方式及单次提交校验。未知或不完整页面阻断。付款步骤停止；未完成真实官网验收。
- Apple Watch 自动购买未实现，并在状态校验层明确拒绝；库存查询功能独立保留。

本融合版按 GPL-3.0 提供，完整许可证见根目录与本目录 `LICENSE`。上游署名及相应许可证须随分发保留。软件不隶属于 Apple，不提供担保。
