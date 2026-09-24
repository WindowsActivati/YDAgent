// ============================================================================
//  JSDeepSeek —— 导出到 JS 侧的 DeepSeek 原生类
//
//  JS 侧（deepseek-api.js）：
//    import { DeepSeek } from 'deepseek'
//    DeepSeek.getDeviceConfig()                     // 同步：返回 /etc/miniapp/resources/cfg.json 原文（≤64KB）
//    DeepSeek.chat(requestJsonString)               // Promise：返回 JSON 字符串（成功/失败统一包好）
//    DeepSeek.version()                             // 同步：插件版本
//
//  chat() 返回的 JSON 字符串（与 deepseek-api.js 的约定一致）：
//    {"ok":true,"content":"..."}
//    {"ok":false,"error":{"code":"...","message":"...","status":N}}
//  code === 'unavailable' 表示网络不可用 → JS 走 $falcon.jsapi.net.request 兜底
// ============================================================================

#pragma once

#include <jqutil_v2/JQPublishObject.h>
#include <jqutil_v2/JQFuncDef.h>
#include <jqutil_v2/JQFunctionTemplate.h>
#include <jqutil_v2/JQTemplateEnv.h>   // JQModuleEnv / JQTemplateEnv 完整定义（JQDefs.h 只有前向声明）
#include <quickjs/quickjs.h>

#include <memory>
#include <mutex>
#include <string>

class DeepSeekWorker;

class JSDeepSeek : public JQUTIL_NS::JQPublishObject
{
public:
    JSDeepSeek();
    ~JSDeepSeek() override;

    // 同步：读 /etc/miniapp/resources/cfg.json（读不到返回空串，JS 侧走兜底）
    void getDeviceConfig(JQUTIL_NS::JQFunctionInfo &info);

    // 同步：插件版本号
    void version(JQUTIL_NS::JQFunctionInfo &info);

    // 同步：诊断日志（追加到 /tmp/deepseek_diag.log）
    // 用途：app 内 console 输出不进设备日志，排查 JS 侧问题时靠它落盘
    void debugLog(JQUTIL_NS::JQFunctionInfo &info);

    // 同步：本地持久化（native 直读直写 app 私有 data 目录）
    // 真机 $falcon.jsapi.storage.setStorage 的 Promise 不 resolve（实测自检日志
    // 一行不出、loadHistory 卡死），故改用 native 文件 IO，行为完全可控。
    void storePath(JQUTIL_NS::JQFunctionInfo &info);                  // 文件路径
    void loadStore(JQUTIL_NS::JQFunctionInfo &info);                  // 读整个文件
    void saveStore(JQUTIL_NS::JQFunctionInfo &info);                  // 覆盖写

    // 异步 Promise（模块线程池执行，可阻塞）：
    //   info[0] = 请求 JSON 字符串 {api_base_url, api_key, model, messages, max_tokens, stream, timeout_ms}
    //   resolve = JSON 字符串（ok/error 统一包装，见文件头）
    void chat(JQUTIL_NS::JQAsyncInfo &info);

    // 异步 Promise（流式）：同 chat，但每段增量正文通过 publish 推给 JS。
    //   JS 侧：DeepSeek.on('delta', cb) 收到 { "text": "增量" }
    //   resolve 仍是完整 JSON（{"ok":true,"content":全文}）
    // 增量回调发生在工作线程 → 用 JQ_PUBLISH_TYPE_ASYNC 交给 SDK marshal 到 JS 线程。
    void chatStream(JQUTIL_NS::JQAsyncInfo &info);

private:
    DeepSeekWorker *getWorker() const;

    std::unique_ptr<DeepSeekWorker> worker_;
    mutable std::mutex workerMutex_;
};

// 工厂单例（JSAPI.cpp 里调用，命名与<JS类名>呼应：createDeepSeekModule）
extern JSValue createDeepSeekModule(JQUTIL_NS::JQModuleEnv *env);