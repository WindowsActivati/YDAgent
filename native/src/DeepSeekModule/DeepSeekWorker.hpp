// ============================================================================
//  DeepSeekWorker —— native 网络/文件工作层（供 JSDeepSeek 调用）
//
//  职责：
//    1) readDeviceConfig()  同步读 /etc/miniapp/resources/cfg.json（≤64KB）
//    2) chat(requestJson)   同步执行 HTTPS POST（mbedtls 2.28.9 + POSIX socket）
//
//  约定（与 deepseek-api.js 一致）：
//    入参 requestJson：{api_base_url, api_key, model, messages, max_tokens, stream, timeout_ms}
//    返回 JSON 字符串：{"ok":true,"content":"..."}
//                  或 {"ok":false,"error":{"code":"...","message":"...","status":N}}
//    code === 'unavailable' → JS 走 $falcon.jsapi.net.request 兜底
//
//  线程模型：chat() 在模块线程池里执行（JQAsyncInfo Promise），可阻塞；
//  所有方法绝不抛异常，错误统一打包成 error JSON 返回。
// ============================================================================

#pragma once

#include <functional>
#include <string>

class DeepSeekWorker
{
public:
    // 流式增量回调：每收到一段正文调用一次。
    // ⚠ 在工作线程执行，绝对不能触碰 JS 对象——调用方负责 marshal 到 JS 线程。
    using DeltaFn = std::function<void(const std::string &delta)>;

    DeepSeekWorker() = default;
    ~DeepSeekWorker() = default;

    // 读 /etc/miniapp/resources/cfg.json；文件不存在/超 64KB → 返回 ""
    std::string readDeviceConfig() const;

    // 对 requestJson 发起 DeepSeek chat/completions HTTPS 请求，返回包装好的 JSON 字符串
    std::string chat(const std::string &requestJson) const;

    // 同上，但用 SSE 流式接收：每段增量正文通过 onDelta 回调抛出，
    // 返回值仍是与 chat() 同形的 JSON（{"ok":true,"content":全文}）。
    // 请求体里 stream 由本函数强制置 true，JS 侧无需关心。
    std::string chatStream(const std::string &requestJson, const DeltaFn &onDelta) const;

    // ---------------------------------------------------------------------
    // 文件读写（AI 工具调用用）
    //
    // ⚠ 与 execCommand 同样的边界：本层**不做安全判断**（路径是否允许、
    //   用户是否授权）——全部由 JS 侧负责（见 src/services/tools.js）。
    //   这里只负责读/写/预览 diff，并把结果包成 JSON。
    //
    // readFile  : {"ok":true,"content":"...","size":N} / {"ok":false,"error":"..."}
    // writeFile : {"ok":true,"bytes":N,"created":bool,"diff":"..."} / {"ok":false,"error":"..."}
    //             created=true 表示新建文件（此前不存在）
    //             diff 是写入前后的统一 diff 预览（截断到 ~4KB），供确认页展示
    // ---------------------------------------------------------------------
    std::string readFile(const std::string &path, long maxBytes) const;
    std::string writeFile(const std::string &path, const std::string &content) const;

    // ---------------------------------------------------------------------
    // 执行 shell 命令（AI 工具调用用）
    //
    // ⚠ 安全边界：本函数**不做任何安全判断**——是否危险、要不要拦截、用户是否
    //   授权，全部由 JS 侧负责（见 src/services/tools.js）。这里只保证：
    //     · 有超时（设备无 timeout 命令，用 poll + kill 自己实现）
    //     · 输出有上限（防 OOM）
    //     · 子进程一定会被回收（waitpid，无僵尸进程）
    //
    // 返回 JSON：{"code":N,"output":"...","timedOut":bool,"truncated":bool}
    //   code = 子进程退出码；被信号杀死时为 128+signal
    // 注意：本函数阻塞，必须在工作线程调用（JS 侧走 Promise 异步接口）。
    std::string execCommand(const std::string &cmd, int timeoutMs) const;

    // 诊断日志：把 text 追加到 /tmp/deepseek_diag.log（失败静默）。
    // 用途：app 内 console 输出不会进设备日志（实测 console(appid) 从未出现），
    // 排查 JS 侧问题（如 storage API 探测结果）时唯一可靠的落盘通道。
    std::string debugLog(const std::string &text) const;

    // --- 本地持久化（绕开 $falcon.jsapi.storage）---
    // 背景：真机 $falcon.jsapi.storage.setStorage 调用后 Promise 不 resolve
    // （自检日志一行不出，loadHistory 卡死），且落盘位置不可见。native 直接
    // 读写 app 私有 data 目录，行为完全可控。
    //
    // 存储文件：<app 私有 data 目录>/deepseek_store.json
    //   路径由 /proc/self/maps 中本 .so 的加载路径推断，避免硬编码 appid。
    // 接口为单位「整文件读写」，JSON 结构由 JS 侧维护（KV 数量少，够用）。
    std::string storePath() const;                            // 实际使用的文件路径（诊断用）
    std::string loadStore() const;                            // 读整个文件；不存在返回 ""
    std::string saveStore(const std::string &content) const;  // 覆盖写；返回状态 JSON
};
