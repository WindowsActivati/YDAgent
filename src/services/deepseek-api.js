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

const API_KEY_STORAGE_KEY = 'deepseek_api_key';
const API_BASE_STORAGE_KEY = 'deepseek_api_base_url';
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
//   { apiKey, apiBaseUrl, hasKey, hasBase, configured }
export async function resolveSettings() {
  let storedKey = null;
  let storedBase = null;
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
  const key = storedKey && String(storedKey).trim() ? String(storedKey).trim() : '';
  const base = normalizeBaseUrl(storedBase);
  return {
    apiKey: key,
    apiBaseUrl: base,
    hasKey: !!key,
    hasBase: !!base,
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

export function buildPayload(messages, model) {
  const kept = trimContext(messages);
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  kept.forEach((m) => {
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

// messages: [{role:'user'|'assistant', content}]
// 返回 AI 回复文本（string）；失败抛 ApiError。
export async function chat(messages, opts) {
  const optsObj = opts || {};
  const signal = optsObj.signal || null;
  const apiKey = optsObj.apiKey || (await resolveApiKey());
  const apiBaseUrl = optsObj.apiBaseUrl || (await resolveApiBaseUrl());
  // 未配置（Key 或端点缺失）：直接抛出，避免发出必然失败的请求
  if (!apiKey || !apiBaseUrl) throw new ApiError(NOT_CONFIGURED_MSG, NOT_CONFIGURED, 0);
  const payload = buildPayload(messages, optsObj.model);

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
  const payload = buildPayload(messages, optsObj.model);

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
  chatStream,
  resolveApiKey,
  resolveApiBaseUrl,
  resolveSettings,
  isConfigured,
  saveApiKey,
  saveApiBaseUrl,
  normalizeBaseUrl,
  buildPayload,
  trimContext,
  ApiError,
  NOT_CONFIGURED,
  NOT_CONFIGURED_MSG,
};