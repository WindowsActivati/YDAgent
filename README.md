# YDAgent

运行在**有道词典笔**（Falcon 运行时 / QuickJS / aiot-miniapp，ARMv7）上的 AI 聊天应用。

界面遵循设备内置应用的官方设计系统（`yd-dictpen-haasui`：主色 `#f9532f`、字体 `OPPOSans`、
纯黑底 `#000000`），风格与系统应用商店等原生界面一致。

- **首次使用需自行配置** API Key 与请求端点（应用内设置页填写，存入设备本地）
- 通过**系统输入法**输入文本（复用设备输入法，`global.startTextEdit` 路径）
- **流式输出**：SSE 逐字回显 + 闪烁光标
- **多会话**：左侧抽屉管理多个独立对话，自动命名、可切换/删除
- **多轮上下文**：每个会话独立保存，按 token 预算自动裁剪
- **本地持久化**：对话与配置落盘到 app 私有目录（native 文件 IO）
- **AI 可操作设备**：模型能提议执行 shell 命令、读写文件来排查/操作词典笔，
  **每个操作都必须经用户确认**，写入前可预览 diff（见下方「AI 操作设备与安全」）
- 自动适配屏幕尺寸（真机从 `/etc/miniapp/resources/cfg.json` 读取）
- 双通道网络：优先走 native HTTPS 插件（自包含 mbedtls），失败时回退 `$falcon.jsapi.net.request`

## 目录结构

```
YDAgent/
├── api-mock/                  # 开发期模块 mock（仅 preview/simulator 生效，不进 AMR）
│   ├── deepseek.js            #   mock native 模块（浏览器 fetch 调真实 API）
│   └── global.js              #   mock 系统输入法桥
├── docs/
│   └── official-design-tokens.md  # 从设备内置 app 提取的官方 UI 设计规范
├── native/                    # 原生插件（自包含 HTTPS 客户端，ARMv7 交叉编译）
│   ├── build.sh               #   WSL2 构建脚本（首次自动解压 mbedtls → cacert.h → 编译 → 校验）
│   ├── CMakeLists.txt
│   ├── compat.h               #   运行库版本兼容（存档）
│   ├── src/
│   │   ├── JSAPI.cpp          #   模块注册入口（libjsapi_deepseek.so）
│   │   └── DeepSeekModule/    #   JSDeepSeek / DeepSeekWorker / MiniJson
│   ├── third_party/
│   │   ├── mbedtls-2.28.9.tar.gz  # mbedtls 源码包（构建时自动解压）
│   │   └── cacert.pem         # 嵌入式 CA 证书（Mozilla bundle，121 张）
│   └── iot-miniapp-sdk/       # Falcon JSAPI SDK 头文件与少量源文件
├── profiles/
│   └── youdao-armv7.yaml      # ARMv7 打包配置
├── scripts/
│   └── sync-native.js         # 把 native 编译产物同步到 libs/（打包前手动跑）
├── src/
│   ├── config.js              # 应用配置（appid / 模型 / 存储键 / token 预算）
│   ├── app.js                 # 应用入口（onLaunch 里按设备宽度 setViewPort）
│   ├── app.json               # 页面注册（启动页必须为 index）
│   ├── base-page.js           # 页面基类（统一资源释放）
│   ├── pages/index/           # 主页面：聊天 + 会话抽屉 + 设置页
│   ├── services/
│   │   ├── deepseek-api.js    # API 服务（native → net.request 双通道 + 上下文裁剪）
│   │   ├── agent.js           # 工具调用循环（授权 → 执行 → 结果回填）
│   │   ├── tools.js           # 工具定义 + 危险命令识别 + 命令执行封装
│   │   ├── sessions.js        # 多会话管理（存储、迁移、命名）
│   │   ├── storage.js         # 存储兼容层（native 文件 IO → $falcon.jsapi.storage → 内存）
│   │   ├── input.js           # 系统输入法封装
│   │   └── device-config.js   # 屏幕适配（cfg.json → $falcon.env → 兜底）
│   └── styles/                # 主题变量（官方设计 token）+ 基础样式
├── .gitignore
├── package.json
└── README.md
```

## 环境要求

| 用途 | 环境 | 说明 |
| --- | --- | --- |
| 原生插件编译 | WSL2 | 需 Linaro GCC 6.3.1 工具链（自带 glibc 2.23 sysroot），见 `native/build.sh` 顶部说明 |
| AMR 打包 | Windows + Node **v18.20.8** | aiot-vue-cli 1.0.32 在新版 node 上安装/运行会失败 |
| 设备部署 | adb + `miniapp_cli` | 设备自带 |

## 快速开始

### PC 模拟器预览

```bash
npm start          # 等价 aiot-cli preview
```

此时 `api-mock/` 生效：`deepseek.js` 用浏览器 fetch 直连 API，`global.js` 用
`window.prompt` 模拟输入法。**注意**：mock 的存储用 localStorage，与真机的
native 文件 IO 行为不同，持久化相关逻辑必须在真机验证。

### 真机打包

```bash
# 1) 编译原生插件（WSL2）
wsl bash -lc "cd /mnt/d/YDAgent && bash native/build.sh"
#    产物：native/build/libs/libjsapi_deepseek.so

# 2) 同步到打包目录
node scripts/sync-native.js

# 3) 打包 AMR（Windows，Node 18）
node node_modules/aiot-vue-cli/src/cli.js -c -q -p
#    产物：<appid>.1_0_0.amr

# 4) 安装并启动
adb push <appid>.1_0_0.amr /tmp/
adb shell miniapp_cli install /tmp/<appid>.1_0_0.amr
adb shell miniapp_cli start <appid> index
```

> `native/build.sh` 会在首次构建时自动从 `third_party/mbedtls-2.28.9.tar.gz`
> 解压 mbedtls 源码（解压目录不进 git）。

## 配置

应用**不内置** API Key 与请求端点。首次使用请在应用内点 ⚙ 填写：

- **API Key**：形如 `sk-...`
- **请求端点**：形如 `https://api.deepseek.com/v1`（可省略 `https://`，会自动补全；尾部斜杠自动去除）

两者都填写后才能开始对话。配置存入设备本地，退出重进保留；设置页可随时修改或清除。

任何 **OpenAI 兼容接口**都可以用（只需填对应端点与 Key）。

## AI 操作设备与安全

模型可通过三个工具操作设备（设备为 Buildroot Linux、**root 权限**，
`/` 只读、`/userdata` 与 `/tmp` 可写）：

| 工具 | 用途 |
| --- | --- |
| `run_command` | 执行 shell 命令并返回输出 |
| `read_file` | 读取文本文件（限白名单目录） |
| `write_file` | 写文件（覆盖/新建，确认页可预览 diff） |

**安全模型**（`src/services/tools.js` + `src/services/agent.js`）：

| 机制 | 说明 |
| --- | --- |
| **每个操作都需用户确认** | 唯一执行闸门 `onConfirm`；代码里没有「自动放行」路径 |
| **文件路径白名单** | 仅允许 `/userdata/`、`/userdisk/`、`/tmp/`；系统目录与路径穿越一律拒绝 |
| **危险命令只警告不拦截** | 命中 15 条危险模式时确认页红字提示风险，用户仍可执行 |
| **写入前预览** | 覆盖已有文件时提示，并在确认页展示内容预览 / diff |
| **无交互式命令** | 子进程 stdin 重定向 `/dev/null`，避免 vim/top 之类挂住 |
| **超时强制终止** | 设备无 `timeout` 命令，native 用 `poll + kill(进程组)` 自实现 |
| **输出上限 256KB** | 防大输出打爆内存 |
| **PC 模拟器不真正执行** | 命令只回显；文件读写走内存 Map，不碰开发机文件系统 |

危险模式覆盖：`rm -rf /`、`dd of=/dev/*`、`mkfs`、分区工具、`reboot/halt`、
`chmod -R 777 /`、fork 炸弹、`kill -1`、内核模块、iptables、`/dev/*` 重定向等。

> ⚠ 注意：由于「只警告不拦截」，若模型被聊天内容诱导（prompt injection）而用户
> 未细看就确认，`/userdata` 下的数据可能被删除。确认页会展示操作原文与风险说明，
> 执行前请扫一眼。

### 为什么文件操作用专用工具而非 shell 重定向

内容含引号/换行时 shell 转义极易出错；大内容受命令行长度限制；且用户只能看到
一长串命令，看不出改了什么。专用工具无转义问题、无长度限制，并能在确认页展示
diff（native 侧用 LCS 生成，截断到 4KB——屏幕只有 170px 高）。

## 通信契约（native ↔ JS）

`DeepSeek.chat(requestJson)` 返回 JSON 字符串：

```json
{"ok":true,"content":"回复内容"}
{"ok":false,"error":{"code":"...","message":"...","status":N}}
```

- `code === "unavailable"`：网络不可用 → JS 侧回退 `$falcon.jsapi.net.request`
- `code === "not_configured"`：未配置 Key/端点 → 引导用户去设置页

流式接口 `DeepSeek.chatStream(requestJson)` 额外通过 `publish('delta', {text})`
推送增量（工作线程 → SDK marshal 到 JS 线程）。

入参：`{api_base_url, api_key, model, messages, max_tokens, stream, timeout_ms}`。

## 本地数据

| 内容 | 位置 |
| --- | --- |
| 对话与会话 | `<app 私有 data 目录>/deepseek_store.json` |
| API 配置 | 同上（键值同文件） |
| 诊断日志 | `/tmp/deepseek_diag.log` |

存储路径由 native 从 `/proc/self/maps` 反推 app 目录，**不硬编码 appid**。

## 开发提示

- 改 native 代码 → 重跑 `native/build.sh` → `sync-native.js` → 重新打包
- **app 内 `console` 输出不进设备日志**；排查 JS 问题用 `DeepSeek.debugLog(text)`
  写 `/tmp/deepseek_diag.log`
- 编辑 `.vue` 模板后检查标签配对（孤立标签会导致渲染错乱且不报错）
- `native/build.sh` 用 `set -o pipefail`，脚本内避免对管道用 `grep -q`（SIGPIPE 假失败）
- 详细踩坑记录见 `docs/official-design-tokens.md` 与代码内注释
