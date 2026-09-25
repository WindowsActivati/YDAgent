// Agent 循环：带工具调用的对话编排。
//
// 流程（一轮 = 一次模型调用，可能需要多轮才能完成用户请求）：
//   1. 带上 tools 调用模型
//   2. 若模型返回 tool_calls → 逐个交给 onConfirm 请用户授权
//        · 用户允许 → native 执行命令 → 结果作为 role:'tool' 消息回填
//        · 用户拒绝 → 回填「用户拒绝了这条命令」，让模型换思路
//   3. 带工具结果再次调用模型，直到模型不再要求调用工具（或达到轮次上限）
//
// 安全：**所有命令都必须经 onConfirm 授权**，本模块不提供任何自动放行路径。

import api from './deepseek-api.js';
import {
  TOOL_DEFS,
  checkDanger,
  runCommand,
  formatResultForModel,
  validateCommand,
  validatePath,
  readFile,
  writeFile,
  formatReadResult,
  formatWriteResult,
} from './tools.js';

// 工具调用轮次上限。
// 用户可随时点「停止」中断，因此这里不再限制轮数（设为 Infinity 表示不限制）。
// 注意：仅在**连续**达到该轮数且期间无任何用户可见产出时才熔断——留作死循环
// 的兜底（例如模型反复调用同一命令），避免无限烧 token 且无从察觉。
const MAX_ROUNDS = Infinity;
// 连续多少轮"只调工具、没产生任何正文"就认为陷入死循环并中止
const MAX_BARREN_ROUNDS = 40;
const DENIED_HINT = '用户拒绝了该操作。请不要重复请求，改用其他方式或直接说明。';

// 执行单个工具调用，返回给模型看的结果文本。
// ★ 每个分支都必须经过 h.onConfirm —— 这是唯一的执行闸门。
async function executeOne(call, args, h, checkAbort) {
  const name = call.function.name;
  const reason = args ? String(args.reason || '') : '';

  if (!args) return '参数不是合法 JSON，请检查后重试。';

  // ---- run_command ----
  if (name === 'run_command') {
    const v = validateCommand(String(args.command || ''));
    if (!v.ok) return '命令无效：' + v.reason;
    const dangers = checkDanger(v.command);
    const allowed = h.onConfirm
      ? await h.onConfirm({ kind: 'command', command: v.command, reason, dangers })
      : false;
    checkAbort();
    if (!allowed) return DENIED_HINT;
    if (h.onCommandStart) h.onCommandStart({ command: v.command, reason });
    const res = await runCommand(v.command, h.timeoutMs);
    if (h.onCommandEnd) h.onCommandEnd({ command: v.command, result: res });
    return formatResultForModel(res);
  }

  // ---- read_file ----
  if (name === 'read_file') {
    const v = validatePath(String(args.path || ''));
    if (!v.ok) return '路径无效：' + v.reason;
    const allowed = h.onConfirm
      ? await h.onConfirm({ kind: 'read', path: v.path, reason, dangers: [] })
      : false;
    checkAbort();
    if (!allowed) return DENIED_HINT;
    if (h.onFileStart) h.onFileStart({ kind: 'read', path: v.path, reason });
    const res = await readFile(v.path);
    if (h.onFileEnd) h.onFileEnd({ kind: 'read', path: v.path, result: res });
    return formatReadResult(res);
  }

  // ---- write_file ----
  if (name === 'write_file') {
    const v = validatePath(String(args.path || ''));
    if (!v.ok) return '路径无效：' + v.reason;
    const content = typeof args.content === 'string' ? args.content : '';
    // 覆盖已有文件属于破坏性操作 → 复用危险提示机制
    const dangers = [];
    const prev = await readFile(v.path, 1); // 只探是否存在（maxBytes=1）
    if (prev.ok) dangers.push('将覆盖已有文件（原内容会被替换）');

    const allowed = h.onConfirm
      ? await h.onConfirm({
          kind: 'write',
          path: v.path,
          content,
          bytes: content.length,
          isNew: !prev.ok,
          reason,
          dangers,
        })
      : false;
    checkAbort();
    if (!allowed) return DENIED_HINT;
    if (h.onFileStart) h.onFileStart({ kind: 'write', path: v.path, reason });
    const res = await writeFile(v.path, content);
    if (h.onFileEnd) h.onFileEnd({ kind: 'write', path: v.path, result: res });
    return formatWriteResult(v.path, res);
  }

  return '未知工具：' + name;
}

// 把 assistant 的 tool_calls 消息转成 API 要求的格式（arguments 必须是字符串）
function normalizeToolCalls(rawCalls) {
  const out = [];
  for (let i = 0; i < rawCalls.length; i++) {
    const c = rawCalls[i];
    if (!c || typeof c !== 'object') continue;
    const fn = c.function || {};
    out.push({
      id: String(c.id || 'call_' + i),
      type: 'function',
      function: {
        name: String(fn.name || ''),
        // API 要求 arguments 是 JSON 字符串；部分服务端可能已给对象，统一成字符串
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
      },
    });
  }
  return out;
}

function parseArgs(fn) {
  try {
    const a = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    return a && typeof a === 'object' ? a : {};
  } catch (e) {
    return null; // 解析失败：模型给了非法 JSON
  }
}

/**
 * 带工具的对话。
 *
 * @param {Array} messages  完整消息数组（会就地追加 assistant/tool 消息）
 * @param {Object} handlers
 *   onConfirm({command, reason, dangers}) -> Promise<boolean>
 *       dangers 非空表示命中危险模式（界面应红字警告），但用户仍可允许
 *   onCommandStart({command, reason}) -> void
 *   onCommandEnd({command, result})   -> void
 *   onAssistantText(text)             -> void  模型在调用工具前说的话（可空）
 *   onDelta(text)                     -> void  流式增量（可选；仅用于最终回答）
 *   signal                            -> {aborted}
 * @returns {Promise<string>} 最终回答文本
 */
export async function runWithTools(messages, handlers) {
  const h = handlers || {};
  const signal = h.signal || null;
  const toolsEnabled = h.toolsEnabled !== false;

  const abortErr = () => {
    const e = new Error('已取消');
    e.code = 'aborted';
    return e;
  };
  const checkAbort = () => {
    if (signal && signal.aborted) throw abortErr();
  };

  let barrenRounds = 0; // 连续"只调工具、无正文产出"的轮数

  for (let round = 0; round < MAX_ROUNDS; round++) {
    checkAbort();

    // 只有第一轮允许工具；后续轮次若模型仍在调工具则继续允许（多步任务）
    const opts = { signal };
    if (toolsEnabled) {
      opts.tools = TOOL_DEFS;
      opts.tool_choice = 'auto';
    }
    // 逐字回显：把增量透传给 UI（UI 负责节流与渲染）
    if (h.onDelta) opts.onDelta = h.onDelta;

    const res = await api.chatRaw(messages, opts);
    checkAbort();

    const hasCalls = !!(res.toolCalls && res.toolCalls.length);
    const hasText = !!(res.content && res.content.trim());

    // 一轮结束：告诉 UI 本轮结果，由它决定"这段文字定为最终答案"还是
    // "只是调用工具前的说明、需要另起一个气泡继续"。
    if (h.onRoundEnd) {
      h.onRoundEnd({ hadToolCalls: hasCalls, content: res.content || '' });
    }

    // 无工具调用 → 这就是最终回答
    if (!hasCalls) {
      return res.content || '';
    }

    // 死循环兜底：连续多轮既不说话也不结束，只反复调工具
    barrenRounds = hasText ? 0 : barrenRounds + 1;
    if (barrenRounds >= MAX_BARREN_ROUNDS) {
      checkAbort();
      return '（工具调用已连续进行 ' + barrenRounds + ' 轮仍无结果，已自动停止。'
           + '可以告诉我更具体的目标，或换一种方式。）';
    }

    const calls = normalizeToolCalls(res.toolCalls);

    // 记录 assistant 的 tool_calls 消息（协议要求：tool 消息必须紧跟其 assistant）
    // 说明文字已通过 onDelta 流进气泡，并已由 onRoundEnd 处理收尾，此处不重复插入。
    messages.push({
      role: 'assistant',
      content: res.content || '',
      tool_calls: calls,
    });

    // 逐个执行（串行：命令之间可能有依赖，且避免同时弹多个授权框）
    for (let i = 0; i < calls.length; i++) {
      checkAbort();
      const call = calls[i];
      const args = parseArgs(call.function);

      const resultText = await executeOne(call, args, h, checkAbort);
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  // 超出轮次上限：让模型基于已有信息收尾
  return '（已达到工具调用轮次上限，请让我根据现有信息继续或换一种问法）';
}

export default { runWithTools };
