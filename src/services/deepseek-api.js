// DeepSeek API 服务层。
//
// 双通道策略：
//   1. native libjsapi_deepseek.so 的 DeepSeek.chat() —— POSIX socket + mbedtls，
//      自带 CA 证书，不依赖系统网络栈（真机首选）
//   2. $falcon.jsapi.net.request —— 系统网络桥（native 不可用时的兜底）
//
// native 返回 JSON 字符串：
//   {"ok":true,"content":"..."}                     成功
//   {"ok":false,"error":{"code":"...","message":"..."}}  失败
//   其中 code === 'unavailable' 表示 native 网络不可用 → 走 fallback；
//   其他 code（如 auth/invalid_request）直接抛错，避免重复请求。
// api-mock 的实现会抛 new Error('native-unavailable')，同样触发 fallback。

import CONFIG from '../config.js';
import { DeepSeek } from 'deepseek'; // native 模块；开发期由 api-mock/deepseek.js 兜底
import { getItem, setItem, removeItem } from './storage.js';

// 诊断（app 内 console 不进设备日志，走 native 落盘）
function diagKey(msg) {
  try {
    if (DeepSeek && typeof DeepSeek.debugLog === 'function') DeepSeek.debugLog('[api] ' + msg);
  } catch (e) { /* 忽略 */ }
}

const API_KEY_STORAGE_KEY = 'deepseek_api_key';
const API_BASE_STORAGE_KEY = 'deepseek_api_base_url';
const MODEL_STORAGE_KEY = 'deepseek_model';
const NET_UNAVAILABLE = 'unavailable';

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message || 'API 请求失败');
    this.name = 'ApiError';
    this.code = code || 'unknown';
    this.status = status || 0;
  }
}

// 未配置时的统一错误码与文案（UI 据此引导用户去设置页）
export const NOT_CONFIGURED = 'not_configured';
export const NOT_CONFIGURED_MSG = '请先在设置里填写 API Key 和请求端点';

// 模型名：storage 覆盖值优先，否则用内置默认。
// 不同服务商的模型名不一样（如 deepseek-chat / gpt-4o-mini / qwen-plus），
// 所以允许用户自行填写。返回 Promise（storage 是异步的）。
export async function resolveModel() {
  try {
    const stored = await getItem(MODEL_STORAGE_KEY, null);
    const m = stored == null ? '' : String(stored).trim();
    if (m) return m;
  } catch (e) {
    // 忽略存储异常，用默认
  }
  return CONFIG.model;
}

// 模型名归一化：去掉空白与换行；允许字母数字及 . _ - : /（兼容
// 各类服务商的命名，如 gpt-4o-mini、qwen2.5-7b-instruct、accounts/x/models/y）
export function normalizeModel(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (!s) return '';
  if (s.length > 128) return '';
  if (!/^[A-Za-z0-9._:\/-]+$/.test(s)) return '';
  return s;
}

// 保存模型名（空串 = 清除覆盖，回退默认）
export async function saveModel(value) {
  const v = normalizeModel(value);
  if (!v) {
    await removeItem(MODEL_STORAGE_KEY);
    return CONFIG.model;
  }
  await setItem(MODEL_STORAGE_KEY, v);
  return v;
}

// API Key：从设备存储读取；未设置返回 ''（不再有内置默认值）
export async function resolveApiKey() {
  try {
    const stored = await getItem(API_KEY_STORAGE_KEY, null);
    if (stored && String(stored).trim()) return String(stored).trim();
  } catch (e) {
    // 忽略存储异常，按未配置处理
  }
  return CONFIG.apiKey || '';
}

// API 端点：从设备存储读取；未设置返回 ''（不再有内置默认值）。
// 返回 Promise（storage 是异步的）；调用点统一 await。
// 与 native 侧解析保持一致：仅接受 https://host[:port][/path]，不支持 http。
export async function resolveApiBaseUrl() {
  try {
    const stored = await getItem(API_BASE_STORAGE_KEY, null);
    const url = normalizeBaseUrl(stored);
    if (url) return url;
  } catch (e) {
    // 忽略存储异常，按未配置处理
  }
  return CONFIG.apiBaseUrl || '';
}

// 是否已完成必要配置（Key 与端点都非空）
export async function isConfigured() {
  const key = await resolveApiKey();
  const base = await resolveApiBaseUrl();
  return !!(key && base);
}

// 归一化用户输入的端点：补协议、去尾部斜杠、校验。返回 '' 表示无效。
export function normalizeBaseUrl(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, ''); // 去掉尾部斜杠（路径拼接时会再加）
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(s)) return '';
  return s;
}

// 保存 Key（空串 = 清除）
export async function saveApiKey(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) {
    await removeItem(API_KEY_STORAGE_KEY);
    return '';
  }
  await setItem(API_KEY_STORAGE_KEY, v);
  return v;
}

// 保存端点（空串 = 清除）
export async function saveApiBaseUrl(value) {
  const v = normalizeBaseUrl(value);
  if (!v) {
    await removeItem(API_BASE_STORAGE_KEY);
    return '';
  }
  await setItem(API_BASE_STORAGE_KEY, v);
  return v;
}

// 当前生效值（供设置界面回显）：
//   { apiKey, apiBaseUrl, model, hasKey, hasBase, hasModel, configured }
// 注意：模型名有内置默认值，所以它**不影响** configured（只有 Key 和端点
// 是必填项；不填模型名就用默认的 deepseek-chat）。
export async function resolveSettings() {
  let storedKey = null;
  let storedBase = null;
  let storedModel = null;
  try {
    storedKey = await getItem(API_KEY_STORAGE_KEY, null);
  } catch (e) {
    /* 忽略 */
  }
  try {
    storedBase = await getItem(API_BASE_STORAGE_KEY, null);
  } catch (e) {
    /* 忽略 */
  }
  try {
    storedModel = await getItem(MODEL_STORAGE_KEY, null);
  } catch (e) {
    /* 忽略 */
  }
  const key = storedKey && String(storedKey).trim() ? String(storedKey).trim() : '';
  const base = normalizeBaseUrl(storedBase);
  const customModel = normalizeModel(storedModel);
  return {
    apiKey: key,
    apiBaseUrl: base,
    model: customModel || CONFIG.model,
    hasKey: !!key,
    hasBase: !!base,
    hasModel: !!customModel, // true = 用户自定义过（非默认）
    defaultModel: CONFIG.model,
    configured: !!(key && base),
  };
}

const SYSTEM_PROMPT =
  '你是一个嵌入在词典笔里的 AI 助手（YDAgent）。请用简体中文回答，' +
  '回答尽量简洁、准确，适合在窄屏设备上分段阅读。';

// 粗略 token 估算：中文约 1 字 1 token，英文约 4 字符 1 token。
// 不引入 tokenizer（词典笔上没必要），只要偏保守即可。
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
  }
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4) + 4; // +4 覆盖 role 等协议开销
}

// 多轮上下文裁剪：从最近的消息往回取，直到达到 token 预算。
// 保证「结果始终以完整轮次为单位」——不会出现孤立的 assistant 开头，
// 且第一条必须是 user（DeepSeek API 对此敏感）。
export function trimContext(messages, budgetTokens) {
  const budget = budgetTokens || CONFIG.contextTokenBudget;
  const src = (messages || []).filter(
    (m) => m && typeof m.content === 'string' && m.content && m.role !== 'system'
  );
  // 从尾部累积；超预算就丢最旧的
  const kept = [];
  let used = estimateTokens(SYSTEM_PROMPT);
  for (let i = src.length - 1; i >= 0; i--) {
    const t = estimateTokens(src[i].content);
    if (kept.length && used + t > budget) break;
    used += t;
    kept.unshift(src[i]);
  }
  // 规整：丢掉开头孤立的 assistant（上下文必须以 user 开始）
  while (kept.length && kept[0].role === 'assistant') kept.shift();
  return kept;
}

// 判断是否为 agent 协议消息（带 tool_calls 的 assistant / tool 结果）。
// 这类消息有严格的结构要求，不能像普通对话那样被裁剪或改写角色。
function isProtocolMessage(m) {
  return !!(m && (m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.tool_calls))));
}

export function buildPayload(messages, model) {
  const src = messages || [];
  // 普通对话部分参与上下文裁剪；协议消息（tool_calls / tool 结果）必须整段保留，
  // 否则 API 会因为 tool 消息找不到对应的 assistant 而报错。
  const plain = src.filter((m) => !isProtocolMessage(m));
  const kept = trimContext(plain);
  const keptSet = new Set(kept);

  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  src.forEach((m) => {
    if (!m || typeof m.content !== 'string') return;
    if (isProtocolMessage(m)) {
      if (m.role === 'tool') {
        msgs.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
      } else {
        const item = { role: 'assistant', content: m.content || '' };
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) item.tool_calls = m.tool_calls;
        msgs.push(item);
      }
      return;
    }
    if (!keptSet.has(m)) return; // 被上下文裁剪掉的旧消息
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  });
  return {
    model: model || CONFIG.model,
    messages: msgs,
    stream: false,
    max_tokens: CONFIG.maxTokens,
  };
}

function extractContent(choices) {
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0];
    if (first && first.message && typeof first.message.content === 'string') {
      return first.message.content;
    }
    if (first && typeof first.text === 'string') return first.text; // 兼容部分镜像
  }
  return null;
}

function parseDeepSeekError(body) {
  if (body && body.error) {
    const e = body.error;
    return new ApiError(e.message || '请求失败', e.code || e.type || 'api_error', body.statusCode || 0);
  }
  return new ApiError('未知错误', 'unknown', 0);
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new ApiError('请求超时', 'timeout', 0)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- fallback：$falcon.jsapi.net.request ----------

function normalizeNetResponse(res) {
  // 兼容 {statusCode,data} / {status,body} / {error,result} 三种形态
  let statusCode = 0;
  let data = null;
  if (res && typeof res === 'object') {
    if (typeof res.statusCode === 'number') statusCode = res.statusCode;
    else if (typeof res.status === 'number') statusCode = res.status;
    if (typeof res.data === 'string') {
      try {
        data = JSON.parse(res.data);
      } catch (e) {
        data = res.data;
      }
    } else if (res.data !== undefined) data = res.data;
    else if (res.body !== undefined) data = res.body;
    else if (res.result !== undefined) data = res.result;
  }
  return { statusCode, data };
}

// nativeMsg：native 通道失败时的真实原因（用于诊断，不再吞掉）
async function netFallbackChat(payload, apiBaseUrl, apiKey, signal, nativeMsg) {
  const net = (typeof $falcon !== 'undefined' && $falcon.jsapi && $falcon.jsapi.net) || null;
  if (!net || typeof net.request !== 'function') {
    const detail = nativeMsg ? `（native 通道: ${nativeMsg}）` : '';
    throw new ApiError('网络不可用（未检测到 net.request）' + detail, NET_UNAVAILABLE, 0);
  }
  const requestPromise = Promise.resolve(
    net.request({
      url: apiBaseUrl + '/chat/completions',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      data: payload,
    })
  ).then((res) => {
    if (signal && signal.aborted) throw new ApiError('已取消', 'aborted', 0);
    const { statusCode, data } = normalizeNetResponse(res);
    if (statusCode >= 200 && statusCode < 300) {
      const content = extractContent(data && data.choices);
      if (content != null) return { content };
      throw parseDeepSeekError(data);
    }
    throw parseDeepSeekError(data);
  });
  return withTimeout(requestPromise, CONFIG.requestTimeoutMs);
}

// ---------- 流式事件订阅 ----------

// native 通过 publish('delta', {text}) 推送增量；JS 侧订阅一次，用 handler 分发。
// native 对象是 JQPublishObject，'on'/'off' 由 SDK 提供（token 由 on 返回）。
let deltaHandler = null;
let deltaToken = null;

function ensureDeltaSubscription() {
  if (deltaToken != null) return;
  if (typeof DeepSeek.on !== 'function') return;
  try {
    deltaToken = DeepSeek.on('delta', (d) => {
      const h = deltaHandler;
      if (!h) return;
      const text = d && typeof d.text === 'string' ? d.text : '';
      if (text) h(text);
    });
  } catch (e) {
    deltaToken = null;
  }
}

// ---------- 主入口 ----------

// 底层调用：返回 { content, toolCalls }，供 agent 循环使用（需要看到 tool_calls）。
// 普通 UI 走 chat() / chatStream()，不需要关心这一层。
//
// 优先走**流式**通道：这样即使对话启用了工具，正文也是逐字到达的
// （native 的 SSE 解析同时支持 content 增量与 tool_calls 增量）。
export async function chatRaw(messages, opts) {
  const optsObj = opts || {};
  const signal = optsObj.signal || null;
  const apiKey = optsObj.apiKey || (await resolveApiKey());
  const apiBaseUrl = optsObj.apiBaseUrl || (await resolveApiBaseUrl());
  if (!apiKey || !apiBaseUrl) throw new ApiError(NOT_CONFIGURED_MSG, NOT_CONFIGURED, 0);

  const model = optsObj.model || (await resolveModel());
  const payload = buildPayload(messages, model);
  if (Array.isArray(optsObj.tools) && optsObj.tools.length) {
    payload.tools = optsObj.tools;
    if (optsObj.tool_choice) payload.tool_choice = optsObj.tool_choice;
  }

  const body = Object.assign({}, payload, {
    api_base_url: apiBaseUrl,
    api_key: apiKey,
    timeout_ms: CONFIG.requestTimeoutMs,
  });
  const bodyJson = JSON.stringify(body);

  // 诊断：记录本次请求使用的 Key 特征，用于确认"存储里的 Key"与"实际发送的
  // Key"是否一致（401 排查的关键信息）。
  // 只记录长度与前缀格式，**不记录任何字符片段**——日志可能在排查时被分享出去。
  try {
    const k = String(apiKey);
    const looksValid = /^sk-[A-Za-z0-9_-]+$/.test(k);
    diagKey('请求: keyLen=' + k.length + ' 格式' + (looksValid ? '正常' : '异常!') +
            ' model=' + model + ' base=' + apiBaseUrl);
  } catch (e) { /* 忽略 */ }
  const onDelta = typeof optsObj.onDelta === 'function' ? optsObj.onDelta : null;

  let nativeError = null;

  // 1) 流式（native ≥ 支持 chatStream 时）
  if (typeof DeepSeek.chatStream === 'function') {
    try {
      ensureDeltaSubscription();
      if (onDelta) deltaHandler = (t) => onDelta(t);
      const raw = await withTimeout(
        Promise.resolve(DeepSeek.chatStream(bodyJson)),
        CONFIG.requestTimeoutMs + 10000
      );
      if (onDelta) deltaHandler = null;
      const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (res && res.ok === true) {
        return { content: res.content || '', toolCalls: res.tool_calls || null };
      }
      const err = (res && res.error) || {};
      if (err.code !== NET_UNAVAILABLE) {
        // 记录失败详情（含 status / code），便于区分 401/429/格式错误
        diagKey('流式请求失败: code=' + (err.code || '?') + ' status=' + (err.status || 0) +
                ' msg=' + (err.message || ''));
        throw new ApiError(err.message || 'native 请求失败', err.code || 'native_error', err.status || 0);
      }
      nativeError = new ApiError(err.message || 'native 网络不可用', NET_UNAVAILABLE, 0);
    } catch (e) {
      if (onDelta) deltaHandler = null;
      if (e instanceof ApiError && e.code !== NET_UNAVAILABLE) throw e;
      nativeError = e;
    }
  }

  // 2) 非流式（旧版 native 或流式失败）
  if (typeof DeepSeek.chat === 'function') {
    try {
      const raw = await withTimeout(
        Promise.resolve(DeepSeek.chat(bodyJson)),
        CONFIG.requestTimeoutMs + 5000
      );
      const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (res && res.ok === true) {
        return { content: res.content || '', toolCalls: res.tool_calls || null };
      }
      const err = (res && res.error) || {};
      if (err.code !== NET_UNAVAILABLE) {
        throw new ApiError(err.message || 'native 请求失败', err.code || 'native_error', err.status || 0);
      }
      nativeError = new ApiError(err.message || 'native 网络不可用', NET_UNAVAILABLE, 0);
    } catch (e) {
      if (e instanceof ApiError && e.code !== NET_UNAVAILABLE) throw e;
      nativeError = e;
    }
  }

  // 3) 回退到系统网络桥（不支持 function calling，仅普通对话）
  const r = await netFallbackChat(payload, apiBaseUrl, apiKey, signal, nativeError ? nativeError.message : null);
  return { content: r.content || '', toolCalls: null };
}

// messages: [{role:'user'|'assistant', content}]
// 返回 AI 回复文本（string）；失败抛 ApiError。
export async function chat(messages, opts) {
  const optsObj = opts || {};
  const signal = optsObj.signal || null;
  const apiKey = optsObj.apiKey || (await resolveApiKey());
  const apiBaseUrl = optsObj.apiBaseUrl || (await resolveApiBaseUrl());
  // 未配置（Key 或端点缺失）：直接抛出，避免发出必然失败的请求
  if (!apiKey || !apiBaseUrl) throw new ApiError(NOT_CONFIGURED_MSG, NOT_CONFIGURED, 0);
  const model = optsObj.model || (await resolveModel());
  const payload = buildPayload(messages, model);

  if (signal && signal.aborted) throw new ApiError('已取消', 'aborted', 0);

  // 1. native 通道
  let nativeError = null;
  if (typeof DeepSeek.chat === 'function') {
    try {
      const requestBody = Object.assign({}, payload, {
        api_base_url: apiBaseUrl,
        api_key: apiKey,
        timeout_ms: CONFIG.requestTimeoutMs,
      });
      const raw = await withTimeout(
        Promise.resolve(DeepSeek.chat(JSON.stringify(requestBody))),
        CONFIG.requestTimeoutMs + 5000
      );
      let res = null;
      try {
        res = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        throw new ApiError('native 返回非法数据', 'bad_response', 0);
      }
      if (res && res.ok === true && typeof res.content === 'string') {
        return res.content;
      }
      const err = (res && res.error) || {};
      if (err.code === NET_UNAVAILABLE) {
        nativeError = new ApiError(err.message || 'native 网络不可用', NET_UNAVAILABLE, 0);
      } else {
        throw new ApiError(err.message || 'native 请求失败', err.code || 'native_error', err.status || 0);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code !== NET_UNAVAILABLE) throw e;
      nativeError = e;
      // 诊断：native 失败详情打到设备日志（YD_PEN_APP.log 的 console 输出），不再吞掉
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        try {
          const emsg = e && e.message ? e.message : String(e);
          const ecode = e && e.code ? ' (code=' + e.code + ')' : '';
          const estatus = e && e.status ? ' (status=' + e.status + ')' : '';
          console.error('[deepseek] native 通道失败: ' + emsg + ecode + estatus);
        } catch (ignore) {
          /* console 不可用时忽略 */
        }
      }
    }
  }

  // 2. fallback 通道（native 不存在 / 网络不可用）
  //    把 nativeError.message（如「DNS 解析失败: ...」「TLS 握手失败: ...」）带过去，
  //    以便 fallback 失败时用户直接看到 native 的真实失败原因
  return netFallbackChat(payload, apiBaseUrl, apiKey, signal, nativeError ? nativeError.message : null);
}

// ---------------------------------------------------------------------------
// 流式聊天：onDelta(text) 每收到一段增量调用一次（可能非常频繁，调用方注意节流）。
// 返回完整回复文本。native 不支持流式时（旧版 .so / mock），自动退化为一次性返回：
// 此时 onDelta 只在最后被调用一次，前端无需区分两条路径。
// ---------------------------------------------------------------------------
export async function chatStream(messages, opts, onDelta) {
  const optsObj = opts || {};
  const signal = optsObj.signal || null;
  const emit = typeof onDelta === 'function' ? onDelta : () => {};

  if (signal && signal.aborted) throw new ApiError('已取消', 'aborted', 0);

  const apiKey = optsObj.apiKey || (await resolveApiKey());
  const apiBaseUrl = optsObj.apiBaseUrl || (await resolveApiBaseUrl());
  if (!apiKey || !apiBaseUrl) throw new ApiError(NOT_CONFIGURED_MSG, NOT_CONFIGURED, 0);
  const model = optsObj.model || (await resolveModel());
  const payload = buildPayload(messages, model);

  // 无流式能力 → 退化为普通 chat（前端只看到「一次性出现」）
  if (typeof DeepSeek.chatStream !== 'function') {
    const full = await chat(messages, optsObj);
    emit(full);
    return full;
  }

  ensureDeltaSubscription();
  let acc = '';
  deltaHandler = (text) => {
    acc += text;
    emit(text); // 过期由调用方在自己的 onDelta 里守卫（它持有 generation）
  };

  try {
    const requestBody = Object.assign({}, payload, {
      api_base_url: apiBaseUrl,
      api_key: apiKey,
      timeout_ms: CONFIG.requestTimeoutMs,
    });
    const raw = await withTimeout(
      Promise.resolve(DeepSeek.chatStream(JSON.stringify(requestBody))),
      CONFIG.requestTimeoutMs + 10000
    );
    let res = null;
    try {
      res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new ApiError('native 返回非法数据', 'bad_response', 0);
    }
    if (res && res.ok === true && typeof res.content === 'string') {
      // 以 native 的完整正文为准（增量可能因节流有丢失）
      if (res.content !== acc) {
        const rest = res.content.slice(acc.length);
        if (rest) emit(rest);
      }
      return res.content;
    }
    const err = (res && res.error) || {};
    // 流式通道不可用 → 退回非流式（网络层同一套代码，通常同因失败，但值得一试）
    if (err.code === NET_UNAVAILABLE) {
      const full = await chat(messages, optsObj);
      if (full !== acc) {
        const rest = full.slice(acc.length);
        if (rest) emit(rest);
      }
      return full;
    }
    throw new ApiError(err.message || 'native 请求失败', err.code || 'native_error', err.status || 0);
  } finally {
    deltaHandler = null;
  }
}

export default {
  chat,
  chatRaw,
  chatStream,
  resolveApiKey,
  resolveApiBaseUrl,
  resolveModel,
  resolveSettings,
  isConfigured,
  saveApiKey,
  saveApiBaseUrl,
  saveModel,
  normalizeBaseUrl,
  normalizeModel,
  buildPayload,
  trimContext,
  ApiError,
  NOT_CONFIGURED,
  NOT_CONFIGURED_MSG,
};