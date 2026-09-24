// ============================================================================
//  JSAPI 总注册入口 —— DeepSeek 模块
//
//  规则（与技能模板一致）：
//    pluginname == .so 名去 libjsapi_ 前缀去 .so
//               == registerCModuleLoader 第一参
//               == JS `import {DeepSeek} from 'deepseek'` 里的 'deepseek'
//    .so 名：libjsapi_deepseek.so
//   JS 侧使用：`import { DeepSeek } from 'deepseek'`
// ============================================================================

#include <jsmodules/JSCModuleExtension.h>
#include <jquick_config.h>
#include <jqutil_v2/JQTemplateEnv.h>   // JQModuleEnv 完整定义（CreateModule / setModuleExport）
#include "DeepSeekModule/JSDeepSeek.hpp"

using namespace JQUTIL_NS;

static std::vector<std::string> exportList = {
    "DeepSeek",
};

static int module_init(JSContext *ctx, JSModuleDef *m)
{
    auto env = JQModuleEnv::CreateModule(ctx, m, "deepseek");   // 名字必须 == pluginname
    env->setModuleExport("DeepSeek", createDeepSeekModule(env.get()));
    env->setModuleExportDone(JS_UNDEFINED, exportList);
    return 0;
}

DEF_MODULE_LOAD_FUNC_EXPORT(deepseek, module_init, exportList)
// 宏展开为 deepseek_module_load(ctx, moduleName)：moduleName == "deepseek" 时
// JS_NewCModule + AddModuleExport("default") + 逐个 AddModuleExport(exportList)

extern "C" JQUICK_EXPORT void custom_init_jsapis()
{
    registerCModuleLoader("deepseek", &deepseek_module_load);
}