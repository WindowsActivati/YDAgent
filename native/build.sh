#!/usr/bin/env bash
# ============================================================================
#  在 WSL2 中构建 libjsapi_deepseek.so（ARMv7 32 位交叉编译）
#
#  用法（在 WSL2 里，带 /mnt/d/... 路径或 cd 到项目）：
#    bash native/build.sh                # 默认：ARMv7 交叉编译 + 产出 .so
#    TARGET_LIB_DIR=... bash native/build.sh
#
#  环境变量（均有默认值）：
#    TARGET_PROFILE_ID      打包用的 profile（youdao-armv7-deepseek）
#    CROSS_TOOLCHAIN_PREFIX 默认 Linaro GCC 6.3.1（自带 glibc 2.23 sysroot，
#                           与设备运行库版本一致，见 /opt/toolchains 说明）
#    PLUGIN_NAME            deepseek
#    TARGET_LIB_DIR         产物目录（默认 ./build/libs）
#
#  流程：生成 cacert.h → cmake 配置 → 交叉编译 → 校验 ELF/导出符号 → 复制 .so
#        之后可在 Windows 侧用 node18 的 aiot-cli 打包 AMR
# ============================================================================
set -euo pipefail

NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${NATIVE_DIR}/build"
SRC_DIR="${NATIVE_DIR}/src"
MBED_DIR="${NATIVE_DIR}/third_party/mbedtls"
CACERT_PEM="${NATIVE_DIR}/third_party/cacert.pem"
CACERT_H="${SRC_DIR}/DeepSeekModule/cacert.h"

TARGET_PROFILE_ID="${TARGET_PROFILE_ID:-youdao-armv7-deepseek}"
# Linaro GCC 6.3.1 工具链，自带 glibc 2.23 sysroot（设备 glibc 2.23 / GLIBCXX 3.4.22）。
# 早期 Ubuntu GCC11/glibc2.35 编译产物带 fcntl@GLIBC_2.28 / stat@GLIBC_2.33 /
# pthread_once@GLIBC_2.34 / GLIBCXX_3.4.29，设备 dlopen 失败→黑屏；切到 Linaro 从根源消除。
LINARO_TOOLCHAIN="/opt/toolchains/gcc-linaro-6.3.1-2017.05-x86_64_arm-linux-gnueabihf"
CROSS_TOOLCHAIN_PREFIX="${CROSS_TOOLCHAIN_PREFIX:-${LINARO_TOOLCHAIN}/bin/arm-linux-gnueabihf-}"
PLUGIN_NAME="${PLUGIN_NAME:-deepseek}"
TARGET_LIB_DIR="${TARGET_LIB_DIR:-${BUILD_DIR}/libs}"

mkdir -p "${TARGET_LIB_DIR}" "${BUILD_DIR}"

# mbedtls 源码目录不进 git（29MB），仓库里只保留 third_party/mbedtls-2.28.9.tar.gz。
# 首次构建（或清过目录）时自动解压，保证 clone 下来即可构建。
if [ ! -d "${MBED_DIR}" ]; then
    MBED_TGZ="${NATIVE_DIR}/third_party/mbedtls-2.28.9.tar.gz"
    if [ -f "${MBED_TGZ}" ]; then
        echo "==> [0/5] 解压 mbedtls（首次构建，约需十几秒）"
        tar -xzf "${MBED_TGZ}" -C "${NATIVE_DIR}/third_party"
        # 上游 tarball 解压出的目录名即 mbedtls-2.28.9，重命名成构建期望的 mbedtls
        if [ ! -d "${MBED_DIR}" ] && [ -d "${NATIVE_DIR}/third_party/mbedtls-2.28.9" ]; then
            mv "${NATIVE_DIR}/third_party/mbedtls-2.28.9" "${MBED_DIR}"
        fi
    else
        echo "ERROR: ${MBED_DIR} 不存在，也找不到 mbedtls-2.28.9.tar.gz" >&2
        exit 1
    fi
fi

echo "==> [1/5] 生成嵌入式 CA 证书头文件 (cacert.h)"
if [ -f "${CACERT_PEM}" ]; then
    if command -v xxd >/dev/null 2>&1; then
        # 在 cacert.pem 所在目录运行 xxd，符号名固定为 cacert_pem / cacert_pem_len
        # （传绝对路径会生成 _mnt_d_..._cacert_pem 这种不可控符号名）。
        # 关键：mbedtls 2.28 的 mbedtls_x509_crt_parse 只有输入缓冲区以 '\0' 结尾
        # 时才按 PEM 解析（x509_crt.c: buf[buflen-1]=='\0'），否则整包 PEM 会被当
        # DER 解析 → INVALID_FORMAT(-0x2180)。xxd -i 的数组不带结尾 NUL，
        # 因此这里补一个 0x00 并把 cacert_pem_len 定义为「含 NUL 的长度」。
        ( cd "$(dirname "${CACERT_PEM}")" && xxd -i "$(basename "${CACERT_PEM}")" ) | python3 -c '
import re, sys
lines = sys.stdin.read().splitlines()
for i, ln in enumerate(lines):
    if ln.strip() == "};":
        lines[i - 1] = lines[i - 1].rstrip() + ", 0x00"          # 数组末尾补 NUL
    m = re.match(r"^(unsigned int \w+ = )(\d+)(;)$", ln)
    if m:
        lines[i] = m.group(1) + str(int(m.group(2)) + 1) + m.group(3)  # len 含 NUL
print("\n".join(lines))
' > "${CACERT_H}"
    else
        echo "ERROR: xxd 不可用，无法生成 cacert.h" >&2
        exit 1
    fi
    echo "     ${CACERT_H} ($(wc -c < "${CACERT_H}") bytes)"
else
    echo "     cacert.pem 不存在，跳过（TLS 证书校验将不可用）" >&2
fi

echo "==> [2/5] cmake 配置 (${CROSS_TOOLCHAIN_PREFIX})"
cmake -S "${NATIVE_DIR}" -B "${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSROOT="${LINARO_TOOLCHAIN}/arm-linux-gnueabihf/libc" \
    -DCROSS_TOOLCHAIN_PREFIX="${CROSS_TOOLCHAIN_PREFIX}" \
    -DTARGET_PROFILE_ID="${TARGET_PROFILE_ID}"

echo "==> [3/5] 交叉编译"
cmake --build "${BUILD_DIR}" --parallel "$(nproc 2>/dev/null || echo 4)"

SO="${BUILD_DIR}/libjsapi_${PLUGIN_NAME}.so"
if [ ! -f "${SO}" ]; then
    echo "ERROR: ${SO} 未生成" >&2
    exit 1
fi

echo "==> [4/5] 校验产物"
file "${SO}"
readelf -h "${SO}" | grep -E "Class|Machine|Flags" || true
# 注意：set -o pipefail 下不能对管道用 grep -q（匹配后提前退出会让上游收 SIGPIPE 判失败），
# 用 grep -o 完整消费输出再取退出码。
EXPORTED=$(nm -D "${SO}" | grep -c 'custom_init_jsapis' || true)
if [ "${EXPORTED}" -eq 0 ]; then
    echo "ERROR: ${SO} 未导出 custom_init_jsapis" >&2
    nm -D "${SO}" | grep -i jsapi || true
    exit 1
fi
echo "     导出符号: $(nm -D "${SO}" | grep custom_init_jsapis | xargs)"

# 版本符号防回归：设备 glibc<=2.23 / libstdc++<=GLIBCXX_3.4.22，
# 任何 GLIBC_2.24+ / GLIBCXX_3.4.23+ 的 verneed 都会导致设备 dlopen 失败
VERSIONED=$(readelf -V "${SO}" | grep -oE 'GLIBCXX_3\.4\.(2[3-9]|[3-9][0-9])|GLIBC_2\.(2[4-9]|[3-9][0-9])' | sort -u -V || true)
if [ -n "${VERSIONED}" ]; then
    echo "ERROR: 产物依赖了设备(glibc 2.23 / GLIBCXX 3.4.22)不支持的版本符号:" >&2
    echo "${VERSIONED}" >&2
    echo "请检查 native/compat.h 与 CMakeLists.txt 的兼容处理" >&2
    exit 1
fi
echo "     版本符号: $(readelf -V "${SO}" | grep -oE 'GLIBCXX_3\.4\.[0-9]+|GLIBC_[0-9]+\.[0-9]+' | sort -u -V | tr '\n' ' ')"

echo "==> [5/5] 复制产物"
cp "${SO}" "${TARGET_LIB_DIR}/"
echo "OK: ${TARGET_LIB_DIR}/libjsapi_${PLUGIN_NAME}.so"
ls -la "${TARGET_LIB_DIR}/"