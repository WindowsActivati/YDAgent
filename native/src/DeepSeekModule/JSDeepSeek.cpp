// ============================================================================
//  JSDeepSeek 实现 —— 6 步工厂骨架（与技能模板 JSMyModule.cpp 一致）
// ============================================================================

#include "JSDeepSeek.hpp"
#include "DeepSeekWorker.hpp"
#include "MiniJson.hpp" // JVal::escape（流式增量做 JSON 转义）

using namespace JQUTIL_NS;

namespace {

// 同步回调的 info[i] 是裸 JSValueConst（异步的 JQAsyncInfo 才是 Bson），
// 这里统一用 QuickJS API 取字符串参数。
std::string argString(JQFunctionInfo &info, uint32_t index)
{
    if (index >= info.Length()) return std::string();
    JSContext *ctx = info.GetContext();
    JSValueConst v = info[index];
    if (!JS_IsString(v)) return std::string();
    const char *cs = JS_ToCString(ctx, v);
    if (cs == nullptr) return std::string();
    std::string out(cs);
    JS_FreeCString(ctx, cs);
    return out;
}

} // namespace

// ----------------------------------------------------------------------------
// Factory：1) JQFunctionTemplate::New  2) setObjectCreator  3) 注册方法
//          4) InitTpl（JQPublishObject 必调） 5) CallConstructor  6) JSAPI.cpp setModuleExport
// ----------------------------------------------------------------------------
extern JSValue createDeepSeekModule(JQModuleEnv *env)
{
    JQFunctionTemplateRef tpl = JQFunctionTemplate::New(env, "DeepSeek");
    tpl->InstanceTemplate()->setObjectCreator([]() { return new JSDeepSeek(); });

    tpl->SetProtoMethod("getDeviceConfig", &JSDeepSeek::getDeviceConfig); // sync
    tpl->SetProtoMethod("version", &JSDeepSeek::version);                 // sync
    tpl->SetProtoMethod("debugLog", &JSDeepSeek::debugLog);               // sync
    tpl->SetProtoMethod("storePath", &JSDeepSeek::storePath);             // sync
    tpl->SetProtoMethod("loadStore", &JSDeepSeek::loadStore);             // sync
    tpl->SetProtoMethod("saveStore", &JSDeepSeek::saveStore);             // sync
    tpl->SetProtoMethodPromise("chat", &JSDeepSeek::chat);                // promise
    tpl->SetProtoMethodPromise("chatStream", &JSDeepSeek::chatStream);    // promise + publish('delta')
    tpl->SetProtoMethodPromise("execCommand", &JSDeepSeek::execCommand);  // promise（AI 工具调用）
    tpl->SetProtoMethodPromise("readFile", &JSDeepSeek::readFile);        // promise（AI 工具调用）
    tpl->SetProtoMethodPromise("writeFile", &JSDeepSeek::writeFile);      // promise（AI 工具调用）

    JSDeepSeek::InitTpl(tpl);
    return tpl->CallConstructor();
}

JSDeepSeek::JSDeepSeek()
    : worker_(std::make_unique<DeepSeekWorker>())
{
}

JSDeepSeek::~JSDeepSeek() = default;

DeepSeekWorker *JSDeepSeek::getWorker() const
{
    std::lock_guard<std::mutex> lock(workerMutex_);
    return worker_.get();
}

// ----------------------------------------------------------------------------
// 同步：读设备屏幕配置（/etc/miniapp/resources/cfg.json）
// 只做一次 ≤64KB 的小文件读取，JS 线程上耗时可忽略；失败返回空串走 JS 兜底
// ----------------------------------------------------------------------------
void JSDeepSeek::getDeviceConfig(JQFunctionInfo &info)
{
    try {
        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.GetReturnValue().Set(std::string(""));
            return;
        }
        info.GetReturnValue().Set(w->readDeviceConfig());
    } catch (const std::exception &e) {
        info.GetReturnValue().ThrowInternalError(e.what());
    }
}

void JSDeepSeek::version(JQFunctionInfo &info)
{
    try {
        info.GetReturnValue().Set(std::string("1.0.0"));
    } catch (const std::exception &e) {
        info.GetReturnValue().ThrowInternalError(e.what());
    }
}

// ----------------------------------------------------------------------------
// 同步：诊断日志（追加到 /tmp/deepseek_diag.log）
// JS 侧：DeepSeek.debugLog('文本')  —— 失败也返回 {"ok":...}，绝不抛
// ----------------------------------------------------------------------------
void JSDeepSeek::debugLog(JQFunctionInfo &info)
{
    try {
        std::string text = argString(info, 0);
        if (text.empty()) text = "(empty)";

        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.GetReturnValue().Set(std::string("{\"ok\":false,\"error\":\"no worker\"}"));
            return;
        }
        info.GetReturnValue().Set(w->debugLog(text));
    } catch (const std::exception &e) {
        info.GetReturnValue().Set(std::string("{\"ok\":false,\"error\":\"exception\"}"));
    }
}

// ----------------------------------------------------------------------------
// 本地持久化（native 直读直写，绕开 $falcon.jsapi.storage）
//   storePath() → 实际文件路径（诊断）
//   loadStore() → 文件内容；不存在返回空串（首次运行）
//   saveStore(content) → {"ok":true} / {"ok":false,"error":"..."}
// ----------------------------------------------------------------------------
void JSDeepSeek::storePath(JQFunctionInfo &info)
{
    try {
        DeepSeekWorker *w = getWorker();
        info.GetReturnValue().Set(w ? w->storePath() : std::string(""));
    } catch (const std::exception &e) {
        info.GetReturnValue().Set(std::string(""));
    }
}

void JSDeepSeek::loadStore(JQFunctionInfo &info)
{
    try {
        DeepSeekWorker *w = getWorker();
        info.GetReturnValue().Set(w ? w->loadStore() : std::string(""));
    } catch (const std::exception &e) {
        info.GetReturnValue().Set(std::string(""));
    }
}

void JSDeepSeek::saveStore(JQFunctionInfo &info)
{
    try {
        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.GetReturnValue().Set(std::string("{\"ok\":false,\"error\":\"no worker\"}"));
            return;
        }
        info.GetReturnValue().Set(w->saveStore(argString(info, 0)));
    } catch (const std::exception &e) {
        info.GetReturnValue().Set(std::string("{\"ok\":false,\"error\":\"exception\"}"));
    }
}

// ----------------------------------------------------------------------------
// 异步：DeepSeek chat 请求（线程池执行，允许阻塞）
// 入参：JSON 字符串；出参：JSON 字符串（{ok:true,content} / {ok:false,error}）
// 内部绝不抛异常（DeepSeekWorker::chat 全 try/catch），这里只兜底
// ----------------------------------------------------------------------------
void JSDeepSeek::chat(JQAsyncInfo &info)
{
    try {
        if (info.Length() < 1 || !info[0].is_string()) {
            info.postError("chat: 需要一个 JSON 字符串参数");
            return;
        }
        std::string requestJson = info[0].string_value();

        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.postError("deepseek worker 未初始化");
            return;
        }
        std::string resultJson = w->chat(requestJson);
        info.post(Bson(resultJson)); // Bson(std::string) → JS string，JS 侧 JSON.parse
    } catch (const std::exception &e) {
        info.postError(e.what());
    }
}

// ----------------------------------------------------------------------------
// 异步流式：同 chat，但每段增量正文通过 publish('delta', {text}) 推给 JS。
//   JS 侧：DeepSeek.on('delta', (d) => { d.text })  ← 已注册则每次增量回调一次
//   resolve 仍是完整 JSON（{"ok":true,"content":全文}），便于事务性收尾
//
// 线程：本函数在工作线程执行；onDelta 也在工作线程被调用，因此**不能**直接碰
// JS 对象，改用 publishJSON(JQ_PUBLISH_TYPE_ASYNC) 由 SDK marshal 到 JS 线程
// （SDK 内部会自行 Dup/Free JSValue，并在对象已解绑时安全返回）。
// ----------------------------------------------------------------------------
void JSDeepSeek::chatStream(JQAsyncInfo &info)
{
    try {
        if (info.Length() < 1 || !info[0].is_string()) {
            info.postError("chatStream: 需要一个 JSON 字符串参数");
            return;
        }
        std::string requestJson = info[0].string_value();

        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.postError("deepseek worker 未初始化");
            return;
        }

        DeepSeekWorker::DeltaFn onDelta = [this](const std::string &delta) {
            std::string payload = "{\"text\":\"" + JVal::escape(delta) + "\"}";
            publishJSON("delta", payload, JQ_PUBLISH_TYPE_ASYNC);
        };

        std::string resultJson = w->chatStream(requestJson, onDelta);
        info.post(Bson(resultJson));
    } catch (const std::exception &e) {
        info.postError(e.what());
    }
}

// ----------------------------------------------------------------------------
// 异步：文件读写（AI 工具调用）
//   readFile(path, maxBytes?) / writeFile(path, content)
// ⚠ 安全判断（路径白名单、用户授权）在 JS 侧，本层只做 IO。
// ----------------------------------------------------------------------------
void JSDeepSeek::readFile(JQAsyncInfo &info)
{
    try {
        if (info.Length() < 1 || !info[0].is_string()) {
            info.postError("readFile: 需要路径字符串");
            return;
        }
        std::string path = info[0].string_value();
        long maxBytes = 262144;
        if (info.Length() >= 2 && info[1].is_number()) maxBytes = (long)info[1].number_value();

        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.postError("deepseek worker 未初始化");
            return;
        }
        info.post(Bson(w->readFile(path, maxBytes)));
    } catch (const std::exception &e) {
        info.postError(e.what());
    }
}

void JSDeepSeek::writeFile(JQAsyncInfo &info)
{
    try {
        if (info.Length() < 2 || !info[0].is_string() || !info[1].is_string()) {
            info.postError("writeFile: 需要 (路径, 内容) 两个字符串");
            return;
        }
        std::string path = info[0].string_value();
        std::string content = info[1].string_value();

        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.postError("deepseek worker 未初始化");
            return;
        }
        info.post(Bson(w->writeFile(path, content)));
    } catch (const std::exception &e) {
        info.postError(e.what());
    }
}

// ----------------------------------------------------------------------------
// 异步：执行 shell 命令（AI 工具调用）
//   info[0] = 命令字符串
//   info[1] = 超时毫秒（可选，默认 15000）
//   resolve = JSON 字符串 {"code":N,"output":"...","timedOut":bool,"truncated":bool}
//
// ⚠ 本层不做安全判断：危险命令识别与用户授权由 JS 侧负责（src/services/tools.js）。
//   命令在工作线程执行，可阻塞（内部有超时兜底）。
// ----------------------------------------------------------------------------
void JSDeepSeek::execCommand(JQAsyncInfo &info)
{
    try {
        if (info.Length() < 1 || !info[0].is_string()) {
            info.postError("execCommand: 需要命令字符串");
            return;
        }
        std::string cmd = info[0].string_value();
        int timeoutMs = 15000;
        if (info.Length() >= 2 && info[1].is_number()) {
            timeoutMs = (int)info[1].number_value();
        }

        DeepSeekWorker *w = getWorker();
        if (w == nullptr) {
            info.postError("deepseek worker 未初始化");
            return;
        }
        info.post(Bson(w->execCommand(cmd, timeoutMs)));
    } catch (const std::exception &e) {
        info.postError(e.what());
    }
}