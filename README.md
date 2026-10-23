# iPhoneduo助手aigoodbro · 1.6.0 (1023v1)

> **Apple 门店库存极速监控 · 刷到现货持续响铃 · 一键直达最终下单界面**  
> 官方网站：[aigoodbro.com](https://aigoodbro.com) · 开源协议：GPL-3.0 · 双平台原生支持：**Windows 10/11** & **macOS**

<div align="center">
  <img src="docs/brand/aigoodbro-avatar.png" alt="AiGoodBro 官方卡通吉祥物头像" width="112" style="border-radius:50%; box-shadow:0 6px 20px rgba(0,0,0,0.15); border:3px solid #fff;">
  <p><strong>AiGoodBro 官方吉祥物 · 品牌与设计规范已全线上线</strong></p>
  <p>
    <a href="docs/DESIGN-GUIDELINES.md">📖 品牌设计规范 (Design Guidelines)</a> · 
    <a href="docs/brand/">🎨 官方形象素材库</a> · 
    <a href="https://aigoodbro.com">🌐 访问官方网站</a>
  </p>
</div>

---

## 🌟 核心功能一览 (1023v1 新增)

| 功能板块 | 特性描述 | 优势与安全边界 |
|---|---|---|
| **一键直达下单界面** | 监控任务列表或购买面板点击「**直达下单**」，自动选配容量、颜色、加入购物袋、穿透访客结账、选定指定门店最早可用自提时段与支付方式。 | **停在最终确认页**：直接带您到达“准备下单了吗？”页面并自动置顶激活标签页，由您亲自核对最终金额并点击下单，**绝不私自代扣付款**。 |
| **刷到现货持续响铃** | 一旦探测到目标商品有货（`available: true`），网页立即启动 **Web Audio 纯净三音递增和弦持续循环响铃**，顶部弹出红白脉冲警报条与「🔕 停止响铃」按钮；同时调用系统硬件扬声器鸣响。 | 多重感官强提醒，绝不错过任何放货时机；关闭浏览器仍可通过本机扬声器或手机推送提醒。 |
| **1~60 秒高频轮询** | 刷新间隔下调至 **1 到 60 秒每秒自由可选**（支持 1s~60s、120s、300s）。 | 自由掌控查询频率，既支持极限抢购，也可调至 5~10 秒避免触发官网 429 频控。 |
| **四大地区全线覆盖** | 全面支持 **中国大陆 (CN)、中国香港 (HK)、日本 (JP)、美国 (US)** 直营店自提与邮寄库存查询。 | 智能适配各大区域本地货币（CNY / HKD / JPY / USD）与直营店自提排单规则。 |
| **Windows 零 Python 依赖** | 重构 Windows 原生连接器，**彻底摆脱 Python 依赖**，内置纯 Java Native Messaging 通信桥。 | Windows 用户只需安装 Java，双击 `install_windows.bat` 3 秒全自动完成安装配置。 |
| **多通道手机离线推送** | 支持配置 **Bark（iOS 高速推送）**、**飞书机器人 (Lark)** Webhook 与消息签名。 | 电脑锁屏或浏览器关闭后，后台仍可持续查询并将到货消息直接推送到您手机。 |

---

## 🪟 Windows 用户安装与运行完全手册 (零 Python · 3 秒一键装)

Windows 环境现已实现 **100% 纯原生支持**！**完全不需要安装 Python**，只需要基础 Java 运行环境。

### 🤖 Windows 用户 Codex 一句话全自动安装指令（推荐）

如果您或您的用户使用 **Codex** / **Cursor** / **Claude Code** / **AI 编程助手**，只需将以下这一句话指令发给 AI，AI 即可全自动检测系统、配置环境并完成全部安装：

> **Codex 一句话安装提示词（直接复制发给 AI）**：
> ```text
> 请帮我在当前 Windows 电脑上一键配置 iPhoneduo助手aigoodbro：1. 检查并确保系统已具备 Java 17 或 21 运行环境（若缺失请提示下载 Adoptium OpenJDK 21 msi 并协助配置）；2. 在当前项目目录下执行 work\backend\install_windows.bat 注册 Chrome Native Messaging 原生连接器与本地凭据；3. 运行 start_backend_silent.vbs 静默启动后台服务并验证端口 127.0.0.1 正常响应；4. 输出 Chrome 扩展加载路径（当前目录下的 work\extension），指导我在 chrome://extensions 开启开发者模式并加载已解压扩展程序。
> ```

**使用方法**：
1. 打开 Codex（或 Cursor / 任意 AI 编程工具）；
2. 打开克隆或解压的项目根目录；
3. 将上述这行指令直接粘贴发送给 Codex；
4. Codex 会自动完成环境变量核验、执行注册脚本、无窗静默启动后台，并给出加载扩展的具体路径，30 秒内全自动就绪！

---

### 手动安装步骤

#### 第一步：安装 Java 运行环境（若已有 Java 17 或 21 可跳过）
后台服务需要 Java 17 或 Java 21。推荐安装微软与开源社区最主流的 **Adoptium OpenJDK 21**：
- 👉 **[Adoptium 官方高速下载 (Windows x64 .msi 安装包)](https://adoptium.net/zh-CN/temurin/releases/?version=21)**
- 下载后一路点击“下一步”完成安装即可（默认已勾选添加系统 PATH 环境变量）。

#### 第二步：解压并一键安装配置
1. 下载并解压本项目的发布压缩包（建议解压到常规路径，例如 `D:\iphoneduo-helper`）。
2. **鼠标双击运行目录下的 `install_windows.bat`**：
   - 脚本会自动检测 Java 环境；
   - 自动在 `%LOCALAPPDATA%\ApplePurchaseHelper` 部署后台核心并生成安全配对凭据；
   - 自动生成 Chrome 通信通道并免管理员权限写入注册表（`HKCU`）。
3. 安装成功后，黑框会提示：`Windows 安装已全部顺利完成！`。

#### 第三步：启动 Java 后台服务
根据您的使用习惯任选一种启动方式：
- **方式 A（直观推荐）**：双击 **`start_backend.bat`**  
  会打开一个黑框窗口常驻显示后台轮询日志；
- **方式 B（静默无黑框）**：双击 **`start_backend_silent.vbs`**  
  后台完全静默常驻运行，无任何弹窗打扰。

#### 第四步：在 Chrome 浏览器中加载扩展
1. 打开 Google Chrome 浏览器，在地址栏直接输入访问：`chrome://extensions/`
2. 开启页面右上角的 **「开发者模式」** 开关；
3. 点击左上角的 **「加载已解压的扩展程序」**；
4. 在弹出的文件选择器中，选择本安装包中的 **`extension`**（或仓库中的 `work/extension`）文件夹；
5. 加载完成后，点击浏览器右上角扩展拼图图标打开 **「iPhoneduo助手aigoodbro」**；
6. 页面左侧状态栏显示绿色 **「已连接本机 Java 后台」**，即代表全部配置成功！

> **Windows 常见排查**：
> - 若运行 `install_windows.bat` 提示未检测到 Java，请确认已安装上述 Adoptium Java，或重启一次电脑让环境变量生效。
> - 若扩展页面显示“后台未连接”，请确认已双击运行 `start_backend.bat` 开启后台。

---

## 🍏 macOS 用户安装与运行手册

macOS 环境利用原生 `launchd` 守护进程，可随开机自动常驻。

### 运行前准备
- 操作系统：macOS 12+ (Intel 或 Apple Silicon)
- 安装环境：JDK 21（推荐 `brew install openjdk@21`）及 Chrome 120+

### 一键安装步骤
1. 打开终端（Terminal），克隆或解压代码：
   ```bash
   git clone https://github.com/BLACKIELF/iphoneduo-aigoodbro.git
   cd iphoneduo-aigoodbro
   ```
2. 构建并注册系统级守护后台：
   ```bash
   sh work/backend/build.sh
   python3 work/backend/install_macos.py
   ```
3. 打开 Chrome，访问 `chrome://extensions/`，开启右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择本仓库中的 `work/extension` 文件夹。
5. 打开助手控制台，确认显示绿色「已连接本机 Java 后台」。

> **macOS 服务管理**：
> - 停止后台服务：`launchctl bootout "gui/$(id -u)/com.aigoodbro.apple-helper"`
> - 重启后台服务：`python3 work/backend/install_macos.py`

---

## 🛒 「直达下单界面」与「履约方式」配置说明

本助手不仅提供精准库存监控，更能助您在放货瞬间抢占先机：

### 1. 第一步：明确履约方式（网络送货 vs 门店自提）
在 **「01 选择商品」** 中，第一步即让您清晰决定履约方式：
- **门店自提 (指定直营店取货)**：  
  选择您所在省份与具体 Apple 直营店（如北京三里屯、上海环球港等）。监控将精确锁定该门店的每日配额，直达下单时自动穿透并选配该门店最早可用的提货时间段。
- **送货上门 (官方快递配送)**：  
  由 Apple 官方工厂/仓库直接顺丰快递送达您的个人收货地址。选择此项后省份与门店选择将自动收起，监控列表中显示 `【送货上门】`，直达下单时自动切换为官方送货通道，免去抢门店预约名额的烦恼。

### 2. 从任务卡片单键直达
在监控列表中建立好您心仪的机型（例如 iPhone 17 Pro 256GB 黑色），点击卡片右侧的 **「直达下单」** 按钮。程序将根据您选择的履约方式自动启动自动化流程：自动选配机型规格、加入购物袋、选定门店自提最早时段（或送货上门）、选定支付宝，并直接前台置顶跳转到官网结算页面。

### 3. 到货自动跳转 + 持续响铃
启动监控后，程序在后台高频检测。一旦探测到目标规格有货，系统将**立即启动持续和弦响铃**，并在浏览器中**自动跳转激活下单标签页**，您只需核对价格并点击“立即下单”即可锁定货源！

### 4. 安全第一准则
程序严格停在最终“准备下单了吗？”页面，绝不保存您的个人支付密码，绝不执行无感代扣支付，所有交易均在 Apple 官方加密环境由您手动最终确认。

---

## 🎨 品牌形象与设计规范

本项目全面启用 **AiGoodBro** 官方卡通吉祥物形象（无眼镜版官方设定：深发微翘、Bro 蓝夹克、红拉链袖口细节、直筒长裤与纯白球鞋），已正式停用旧版双开门软件图标：
- **形象资产归档**：收录于 [`docs/brand/`](docs/brand/)，包含 1254×1254 微笑头像、思考头像、惊喜头像及完整三视图；
- **设计规范文件**：详细说明见 [`docs/DESIGN-GUIDELINES.md`](docs/DESIGN-GUIDELINES.md)，规范了角色视觉识别点、排版字体规范（PingFang SC）、状态色彩、Web Audio 纯净和弦持续响铃音频规范与自动跳转安全流程。

---

## 🔄 版本更新与升级检测

在控制台第一部分「版本与升级」中：
- 点击 **「检查更新」**：系统会实时连接 GitHub 检测最新公开版本。
- 若提示 **`✅ 当前已是最新公开版本 (1.6.0)`**：代表本地已是最全新代码，无需执行任何更新操作。
- 若检测到新版本：会自动展示本次更新详情，并为您生成一键「复制 Codex 更新口令」。

---

## 🛡️ 数据隐私与免责声明

1. **本地私有存储**：所有监控任务、Bark/飞书推送密钥仅保存在本机 `%LOCALAPPDATA%`（Windows）或 `Application Support`（macOS）以及扩展本地缓存中，不上传至任何第三方云端。
2. **免责声明**：本软件为开源辅助工具，不隶属于 Apple Inc.，不保证 100% 抢购成功或门店必有库存，一切供货与订单状态以 Apple 官网结账结果为准。
