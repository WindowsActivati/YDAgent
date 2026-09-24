// 把 WSL2 编译出的 native 插件同步到项目根 libs/（打包时 aiot-cli 会原样打进 AMR）
// 用法：node scripts/sync-native.js
// 前置：先在 WSL2 运行 `bash native/build.sh` 产出 native/build/libs/libjsapi_deepseek.so

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../native/build/libs/libjsapi_deepseek.so');
const DST_DIR = path.resolve(__dirname, '../libs');
const DST = path.join(DST_DIR, 'libjsapi_deepseek.so');

if (!fs.existsSync(SRC)) {
  console.error(
    'ERROR: ' + SRC + ' 不存在。\n请先在 WSL2 编译 native 插件:\n  wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/d/DeepSeek && bash native/build.sh"'
  );
  process.exit(1);
}

fs.mkdirSync(DST_DIR, { recursive: true });
fs.copyFileSync(SRC, DST);
console.log('OK: ' + SRC);
console.log(' -> ' + DST + ' (' + fs.statSync(DST).size + ' bytes)');