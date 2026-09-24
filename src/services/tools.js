// AI 工具层：让模型能操作词典笔（Linux 嵌入式设备，root 权限）。
//
// ============================ 安全模型 ============================
//
// 设备以 **root** 运行，命令由 AI 提议、用户逐条授权。核心设计：
//
//   1. **每条命令都要用户点「允许」**（不自动执行任何命令）
//      —— 模型的幻觉、用户输入里的 prompt injection，都会在这里被拦下。
//   2. **危险命令只警告，不拦截**（用户要求：保留高级操作自由）
//      —— 命中危险模式时界面红字提示风险，用户仍可执行。
//   3. **不提供交互式命令**：stdin 重定向到 /dev/null，避免 vim/top 之类挂住。
//   4. **超时与输出上限在 native 侧强制**（设备无 timeout 命令）。
//
// 威胁模型：AI 可能被聊天内容诱导执行破坏性命令。第 1 条是唯一的实质防线——
// 任何"自动放行"的改动都等于把设备交给模型，务必谨慎。

import { DeepSeek } from 'deepseek';

// 工具定义（OpenAI function calling 格式，DeepSeek 兼容）
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在词典笔（Linux 嵌入式设备）上执行一条 shell 命令并返回输出。' +
        '设备为 Buildroot Linux，可用命令：ls/cat/grep/find/ps/df/free/top/' +
        'sed/awk/cp/mv/rm/mkdir/tar/curl/wget/ping 等。' +
        '每条命令都会先由用户确认后才会执行，请一次只做一件事，命令要简短明确。' +
        '注意：根文件系统 / 是只读的，可写的是 /userdata 和 /tmp。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令，例如 "df -h" 或 "ls /userdata"',
          },
          reason: {
            type: 'string',
            description: '一句话说明为什么要执行这条命令（会展示给用户看）',
          },
        },
        required: ['command'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 危险命令识别（仅用于提示，不阻止执行）
// ---------------------------------------------------------------------------

// 每条：{ re: 匹配正则, why: 风险说明 }
const DANGER_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|\*|~)/, why: '递归删除根目录或通配删除，会清空大量文件' },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(userdata|tmp|etc|usr|lib|bin|oem)/, why: '递归删除系统或用户数据目录' },
  { re: /\bdd\b[^|;]*(of=\/dev\/)/, why: '直接写入块设备，可能损坏分区或变砖' },
  { re: /\bmkfs(\.\w+)?\b/, why: '格式化文件系统，数据不可恢复' },
  { re: /\b(fdisk|parted|sgdisk)\b/, why: '修改分区表，可能导致设备无法启动' },
  { re: /\b(reboot|halt|poweroff|shutdown)\b/, why: '重启或关机，可能导致设备暂时不可用' },
  { re: /\bchmod\s+(-R\s+)?777\s+\//, why: '递归修改根目录权限，破坏系统安全' },
  { re: /\bchown\s+-R\b.*\s\/(\s|$)/, why: '递归修改根目录属主' },
  { re: />\s*\/dev\/(mmcblk|mtdblock|block)/, why: '重定向写入块设备' },
  { re: /\b(mv|cp)\b[^|;]*\s\/(bin|sbin|lib|usr|etc)\b/, why: '移动或覆盖系统目录内容' },
  { re: /:\s*\(\)\s*\{.*\}\s*;?\s*:/, why: '疑似 fork 炸弹' },
  { re: /\bkill(all)?\s+(-9\s+)?-?1\b/, why: '向所有进程发送信号，可能导致系统失去响应' },
  { re: /\binsmod|rmmod|modprobe\b/, why: '加载或卸载内核模块，可能使系统不稳定' },
  { re: /\biptables\b/, why: '修改防火墙规则，可能切断网络' },
  { re: /\b(passwd|shadow)\b/, why: '修改账户凭据' },
];

// 返回危险原因数组（空数组 = 未命中）
export function checkDanger(command) {
  const cmd = String(command || '');
  const hits = [];
  for (let i = 0; i < DANGER_PATTERNS.length; i++) {
    if (DANGER_PATTERNS[i].re.test(cmd)) hits.push(DANGER_PATTERNS[i].why);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

// 明显不该执行的（空、纯空白）
export function validateCommand(command) {
  const c = String(command == null ? '' : command).trim();
  if (!c) return { ok: false, reason: '命令为空' };
  if (c.length > 2000) return { ok: false, reason: '命令过长（上限 2000 字符）' };
  return { ok: true, command: c };
}

// 执行命令（native 侧有超时与输出上限）。
// 调用方必须已完成用户授权——本函数不做任何安全判断。
export async function runCommand(command, timeoutMs) {
  const v = validateCommand(command);
  if (!v.ok) {
    return { code: -1, output: v.reason, timedOut: false, truncated: false };
  }
  if (typeof DeepSeek.execCommand !== 'function') {
    return { code: -1, output: '当前 native 插件不支持命令执行', timedOut: false, truncated: false };
  }
  const raw = await Promise.resolve(DeepSeek.execCommand(v.command, timeoutMs || 15000));
  let res;
  try {
    res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { code: -1, output: '命令返回数据异常', timedOut: false, truncated: false };
  }
  if (!res || typeof res !== 'object') {
    return { code: -1, output: '命令返回数据异常', timedOut: false, truncated: false };
  }
  return {
    code: typeof res.code === 'number' ? res.code : -1,
    output: typeof res.output === 'string' ? res.output : '',
    timedOut: !!res.timedOut,
    truncated: !!res.truncated,
  };
}

// 把执行结果整理成给模型看的文本（含退出码，便于模型判断成功与否）
export function formatResultForModel(res) {
  const code = res && typeof res.code === 'number' ? res.code : -1;
  const output = (res && res.output) || '';
  if (code === 0) {
    return output ? output : '(命令执行成功，无输出)';
  }
  if (res && res.timedOut) return output || '命令执行超时';
  const head = '命令失败（退出码 ' + code + '）';
  return output ? head + ':\n' + output : head;
}
