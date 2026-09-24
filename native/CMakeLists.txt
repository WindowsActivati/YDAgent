# ============================================================================
#  libjsapi_deepseek.so —— DeepSeek 原生 JSAPI
#  目标：WSL2 里用 arm-linux-gnueabihf 工具链交叉编译成 ARMv7 32 位
#  (设备固件为 ARMv7，系统整体编译为 32 位)
#
#  产物：build/libjsapi_deepseek.so
#  模块名 "deepseek"：registerCModuleLoader("deepseek") + JS `import {DeepSeek} from 'deepseek'`
# ============================================================================
cmake_minimum_required(VERSION 3.13)
project(jsapi_deepseek C CXX)

# ---------- 交叉编译工具链（与技能模板一致：优先 -D 传入，其次环境变量） ----------
if(DEFINED CROSS_TOOLCHAIN_PREFIX AND NOT CROSS_TOOLCHAIN_PREFIX STREQUAL "")
    set(CMAKE_C_COMPILER "${CROSS_TOOLCHAIN_PREFIX}gcc")
    set(CMAKE_CXX_COMPILER "${CROSS_TOOLCHAIN_PREFIX}g++")
elseif(DEFINED ENV{CROSS_TOOLCHAIN_PREFIX} AND NOT ENV{CROSS_TOOLCHAIN_PREFIX} STREQUAL "")
    set(CMAKE_C_COMPILER "$ENV{CROSS_TOOLCHAIN_PREFIX}gcc")
    set(CMAKE_CXX_COMPILER "$ENV{CROSS_TOOLCHAIN_PREFIX}g++")
elseif(DEFINED ENV{CROSS_C_COMPILER} AND DEFINED ENV{CROSS_CXX_COMPILER})
    set(CMAKE_C_COMPILER "$ENV{CROSS_C_COMPILER}")
    set(CMAKE_CXX_COMPILER "$ENV{CROSS_CXX_COMPILER}")
endif()

set(CMAKE_C_STANDARD 99)
# Linaro GCC 6.3.1 完整支持 C++14（C++17 仅部分特性）；源码只用 C++14（std::make_unique 等）
set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------- 设备运行库版本兼容（见 compat.h） ----------
# 设备 glibc 2.23 + libstdc++ GLIBCXX_3.4.22。
# 早期 Ubuntu GCC11/glibc2.35 产物依赖 fcntl@GLIBC_2.28 / stat@GLIBC_2.33 /
# pthread_once@GLIBC_2.34 / GLIBCXX_3.4.29，设备 dlopen 失败→黑屏。
# 已切换 Linaro GCC 6.3.1 + 自带 glibc 2.23 sysroot（build.sh 里 -DCMAKE_SYSROOT），
# 版本符号天然匹配，不再需要 .symver 重映射；compat.h 仅作存档/扩展位，全局 -include 保留。
set(COMPAT_H "${CMAKE_CURRENT_SOURCE_DIR}/compat.h")
set(CMAKE_C_FLAGS   "${CMAKE_C_FLAGS}   -include ${COMPAT_H}")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -include ${COMPAT_H}")

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(SDK_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/iot-miniapp-sdk")
set(MBED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/mbedtls")
set(PLUGIN_NAME "deepseek")

# ---------- iot_sdk 静态库（JQuick 体系，只做链接资源） ----------
file(GLOB_RECURSE SDK_SOURCES "${SDK_DIR}/src/*.cpp")
add_library(iot_sdk STATIC ${SDK_SOURCES})
target_include_directories(iot_sdk PUBLIC "${SDK_DIR}/include")
target_compile_options(iot_sdk PRIVATE -w -fPIC)

# ---------- mbedtls 2.28.9 静态库（自包含 TLS，不依赖系统 libcurl） ----------
file(GLOB MBED_SOURCES "${MBED_DIR}/library/*.c")
# 用自定义 POSIX socket（带超时控制），不需要 mbedtls 的 net_sockets.c
list(REMOVE_ITEM MBED_SOURCES "${MBED_DIR}/library/net_sockets.c")

add_library(mbedtls STATIC ${MBED_SOURCES})
target_include_directories(mbedtls PUBLIC "${MBED_DIR}/include")
# 说明：mbedtls 2.28 强制 MBEDTLS_SSL_MAX_CONTENT_LEN ≤ 16384（TLS 单条记录上限）。
# 大响应/大请求无需改缓冲：TLS 层自动拆成多条 16KB 记录，DeepSeekWorker 的
# writeAll/RecvBuf 均循环读写，逐条处理即可。
#
# -fvisibility=hidden 是必须的，不是优化：本 .so 被 dlopen 进 miniapp 进程，
# 该进程早已加载宿主的 libfalcon.so（Falcon 运行时），后者同样以 GLOBAL 导出
# 407 个 mbedtls_* 符号（实现尺寸与本仓库 2.28.9 不同，例如
# mbedtls_x509_crt_parse 428B vs 280B）。默认可见性下，动态链接器按全局作用域
# 优先解析，会把我们内部的 mbedtls 调用绑定到 libfalcon 的实现，让它按不同的
# mbedtls_x509_crt 结构体布局写我们的对象 → CA 证书仅 56/121 解析成功、
# mbedtls_x509_crt_parse 返回 65（设备报「CA 证书解析失败 (-0xffffffbf)」）。
# 设为 hidden 后符号不进入动态符号表且链接期即绑定本地，杜绝抢占。
target_compile_options(mbedtls PRIVATE -w -fPIC -fvisibility=hidden)

# ---------- 插件本体 ----------
add_library(jsapi_${PLUGIN_NAME} SHARED
    src/JSAPI.cpp
    src/DeepSeekModule/JSDeepSeek.cpp
    src/DeepSeekModule/DeepSeekWorker.cpp
)
set_target_properties(jsapi_${PLUGIN_NAME} PROPERTIES
    OUTPUT_NAME "jsapi_${PLUGIN_NAME}"
    PREFIX "lib"
)

target_include_directories(jsapi_${PLUGIN_NAME} PRIVATE
    "${SDK_DIR}/include"
    "${MBED_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_compile_options(jsapi_${PLUGIN_NAME} PRIVATE
    -Wall -Wextra -Werror=return-type -Wno-psabi
    -fvisibility=hidden
    -fPIC
)

target_link_libraries(jsapi_${PLUGIN_NAME} PRIVATE iot_sdk mbedtls pthread m)
# 模板约定：SDK 里未实现的符号由宿主提供，c++ 静态库循环依赖用 ignore-all 兜底
#
# -Bsymbolic-functions：库内定义的函数引用一律绑定到本地定义，作为对宿主
# libfalcon.so 符号抢占的第二道防线（mbedtls 已用 -fvisibility=hidden 根治，
# 这里同时保护 iot_sdk 等其余静态库符号）。宿主提供的是「未定义」符号，
# 不受 -Bsymbolic 影响，仍正常解析到宿主。
target_link_options(jsapi_${PLUGIN_NAME} PRIVATE
    "-static-libstdc++"
    "-static-libgcc"
    "-Wl,-Bsymbolic-functions"
    "-Wl,-unresolved-symbols=ignore-all")