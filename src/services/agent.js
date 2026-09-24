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
import { TOOL_DEFS, checkDanger, runCommand, formatResultForModel, validateCommand } from './tools.js';

// 单次用户请求内最多允许的模型轮次（防止模型陷入工具调用死循环）
const MAX_ROUNDS = 8;

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

  for (let round = 0; round < MAX_ROUNDS; round++) {
    checkAbort();

    // 只有第一轮允许工具；后续轮次若模型仍在调工具则继续允许（多步任务）
    const opts = { signal };
    if (toolsEnabled) {
      opts.tools = TOOL_DEFS;
      opts.tool_choice = 'auto';
    }

    const res = await api.chatRaw(messages, opts);
    checkAbort();

    // 无工具调用 → 这就是最终回答
    if (!res.toolCalls || !res.toolCalls.length) {
      return res.content || '';
    }

    const calls = normalizeToolCalls(res.toolCalls);

    // 模型在调用工具前可能先说了句话（如"我先看一下磁盘占用"）
    if (res.content && h.onAssistantText) h.onAssistantText(res.content);

    // 记录 assistant 的 tool_calls 消息（协议要求：tool 消息必须紧跟其 assistant）
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

      let resultText;
      if (call.function.name !== 'run_command') {
        resultText = '未知工具：' + call.function.name;
      } else if (!args) {
        resultText = '参数不是合法 JSON，请重新给出 command 字段';
      } else {
        const cmd = String(args.command || '');
        const v = validateCommand(cmd);
        if (!v.ok) {
          resultText = '命令无效：' + v.reason;
        } else {
          const dangers = checkDanger(v.command);
          // ★ 唯一的执行闸门：必须由用户确认
          let allowed = false;
          if (h.onConfirm) allowed = await h.onConfirm({
            command: v.command,
            reason: String(args.reason || ''),
            dangers,
          });
          checkAbort();

          if (!allowed) {
            resultText = '用户拒绝执行该命令。请不要重复请求，改用其他方式或直接说明。';
          } else {
            if (h.onCommandStart) h.onCommandStart({ command: v.command, reason: String(args.reason || '') });
            const res2 = await runCommand(v.command, h.timeoutMs);
            if (h.onCommandEnd) h.onCommandEnd({ command: v.command, result: res2 });
            resultText = formatResultForModel(res2);
          }
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  // 超出轮次上限：让模型基于已有信息收尾
  return '（已达到工具调用轮次上限，请让我根据现有信息继续或换一种问法）';
}

export default { runWithTools };
