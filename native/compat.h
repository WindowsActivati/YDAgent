/* ============================================================================
 *  compat.h —— 设备运行库版本兼容（已解决，存档保留）
 *  设备（有道词典笔 Falcon）运行库：glibc 2.23 / libstdc++ GLIBCXX_3.4.22
 *  早期用 Ubuntu GCC11/glibc2.35 交叉编译，产物依赖 fcntl@GLIBC_2.28、
 *  stat@GLIBC_2.33、pthread_once@GLIBC_2.34、GLIBCXX_3.4.29 → 设备 dlopen 失败→黑屏。
 *  修复：改用 Linaro GCC 6.3.1 工具链（自带 glibc 2.23 sysroot，见 build.sh），
 *  产物版本符号天然 ≤ GLIBC_2.23 / GLIBCXX_3.4.22，不再需要 .symver 重映射。
 *  此文件保留仅供 CMakeLists 全局 -include 兼容，当前无实际内容。
 * ==========================================================================*/
#ifndef DEEPSEEK_COMPAT_H
#define DEEPSEEK_COMPAT_H

#endif /* DEEPSEEK_COMPAT_H */