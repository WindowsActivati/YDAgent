// 存储兼容层。
//
// 后端优先级（逐级兜底）：
//   1. **native 文件 IO**（真机首选）—— DeepSeek.saveStore/loadStore 直读直写
//      <app 私有 data 目录>/deepseek_store.json。C++ fopen/fwrite 行为完全可控。
//   2. $falcon.jsapi.storage —— API 确实存在（getStorage/setStorage，实证自
//      libfalcon.so 导出符号 + 设备上其他 app 的字节码），但**实测 setStorage 的
//      Promise 不 resolve**（自检日志一行不出、loadHistory 卡死），故降为备选。
//   3. import('storage')
//   4. 内存 Map（开发期，不落盘）
//
// 真机**没有** getItem/setItem；早期按浏览器 localStorage 命名探测 → 全部落空 →
// 退到内存 Map → 退出即失忆。方法名候选表把真机名放最前。
//
// 整个 store 作为**一个 JSON 对象**在内存里维护，写时整文件覆盖（KV 很少，够用），
// 写操作串行化（promise 链）避免并发覆盖。

import { DeepSeek } from 'deepseek'; // 持久化 + debugLog 都靠它

const SCHEMA_VERSION = 1;
const memoryStore = new Map();

let storageAdapter = null;
let adapterReady = false;

// 方法名候选（真机名在前）。不同固件/运行时命名不一，逐一探测而非假定。
const GET_NAMES = ['getStorage', 'getItem', 'get'];
const SET_NAMES = ['setStorage', 'setItem', 'set'];
const REMOVE_NAMES = ['removeStorage', 'removeItem', 'remove', 'deleteStorage'];

function normalizeKey(key) {
  return String(key);
}

function pickFn(target, names) {
  if (!target) return null;
  for (let i = 0; i < names.length; i++) {
    const fn = target[names[i]];
    if (typeof fn === 'function') return fn.bind(target);
  }
  return null;
}

function normalizeRawGetResult(value) {
  // 兼容 { data: "..." } / { value: "..." } / 原始字符串 / null
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value.data === 'string') return value.data;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.result === 'string') return value.result;
    if (typeof value.data !== 'undefined' && value.data !== null) return String(value.data);
  }
  return null;
}

function normalizeRawSetResult() {
  // 写入结果各实现差异大，统一吞掉
}

// 把任意具备 get/set 能力的对象包成统一 adapter；能力不足返回 null
function buildAdapter(store) {
  const getFn = pickFn(store, GET_NAMES);
  const setFn = pickFn(store, SET_NAMES);
  if (!getFn || !setFn) return null;
  const removeFn = pickFn(store, REMOVE_NAMES);
  return {
    persistent: true,
    getItem: (key) => Promise.resolve(getFn(key)).then(normalizeRawGetResult),
    setItem: (key, value) => Promise.resolve(setFn(key, String(value))).then(normalizeRawSetResult),
    removeItem: (key) => {
      // 注意：不要用 clearStorage() 兜底——它清空整个存储，会把无关数据一起抹掉。
      // 没有 remove 能力时宁可不删（脏数据无害，误删是灾难）。
      if (removeFn) return Promise.resolve(removeFn(key)).then(normalizeRawSetResult);
      return Promise.resolve(null);
    },
  };
}

// 候选宿主对象（真机路径在最前）
function candidateStores() {
  const list = [];
  try {
    if (typeof $falcon !== 'undefined' && $falcon) {
      if ($falcon.jsapi && $falcon.jsapi.storage) list.push($falcon.jsapi.storage);
      if ($falcon.storage) list.push($falcon.storage);
      if ($falcon.jsapi && $falcon.jsapi.sharedPreferences) list.push($falcon.jsapi.sharedPreferences);
    }
  } catch (e) {
    // $falcon 不可用时忽略，继续下一级
  }
  return list;
}

// 诊断输出。注意：app 内 console 输出**不进**设备日志（实测 console(appid) 从未出现），
// 故优先走 native 的 debugLog（C++ 直接写 /tmp/deepseek_diag.log），console 仅兜底。
export function logDiag(msg) {
  const line = '[storage] ' + msg;
  try {
    if (DeepSeek && typeof DeepSeek.debugLog === 'function') {
      DeepSeek.debugLog(line);
      return;
    }
  } catch (e) {
    /* native 不可用时走 console */
  }
  try {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[deepseek-storage] ' + line);
    }
  } catch (e) {
    /* 忽略 */
  }
}

// 取 native 存储路径（仅诊断，失败返回 "?"）
function safeStorePath() {
  try {
    if (DeepSeek && typeof DeepSeek.storePath === 'function') {
      const p = DeepSeek.storePath();
      return p ? String(p) : '?';
    }
  } catch (e) {
    /* 忽略 */
  }
  return '?';
}

function describe(v) {
  if (v == null) return String(v);
  if (typeof v === 'function') return 'function';
  if (typeof v !== 'object') return typeof v + '(' + String(v) + ')';
  try {
    const keys = Object.keys(v);
    return 'object{ ' + keys.slice(0, 20).join(', ') + (keys.length > 20 ? ' ...' : '') + ' }';
  } catch (e) {
    return 'object{?(unreadable)}';
  }
}

// native 后端：整文件读写，内部维护 KV 对象
let nativeKv = null; // 已解析的 KV；null = 尚未加载

function nativeBackendAvailable() {
  try {
    return !!(DeepSeek && typeof DeepSeek.loadStore === 'function' && typeof DeepSeek.saveStore === 'function');
  } catch (e) {
    return false;
  }
}

function nativeLoad() {
  if (nativeKv !== null) return nativeKv;
  nativeKv = {};
  try {
    const raw = DeepSeek.loadStore();
    if (raw && typeof raw === 'string' && raw.length) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) nativeKv = parsed;
    }
  } catch (e) {
    logDiag('loadStore 解析失败: ' + (e && e.message ? e.message : String(e)));
    nativeKv = {};
  }
  return nativeKv;
}

function nativePersist() {
  try {
    const rc = DeepSeek.saveStore(JSON.stringify(nativeKv || {}));
    return Promise.resolve(rc);
  } catch (e) {
    logDiag('saveStore 异常: ' + (e && e.message ? e.message : String(e)));
  }
  return Promise.resolve(null);
}

function buildNativeAdapter() {
  return {
    persistent: true,
    getItem: (key) => {
      const kv = nativeLoad();
      return Promise.resolve(Object.prototype.hasOwnProperty.call(kv, key) ? String(kv[key]) : null);
    },
    setItem: (key, value) => {
      const kv = nativeLoad();
      kv[key] = String(value);
      return nativePersist();
    },
    removeItem: (key) => {
      const kv = nativeLoad();
      delete kv[key];
      return nativePersist();
    },
  };
}

async function detectAdapter() {
  if (adapterReady) return storageAdapter;

  // 1. native 文件 IO（真机首选：$falcon.jsapi.storage 的 Promise 会挂起）
  if (nativeBackendAvailable()) {
    const adapter = buildNativeAdapter();
    // 立即做一次读，验证路径与读能力（写验证交给 selfTest）
    const kv = nativeLoad();
    logDiag('存储就绪: native 文件 IO; 路径=' + safeStorePath() +
      '; 已有 key=' + Object.keys(kv).length);
    storageAdapter = adapter;
    adapterReady = true;
    return storageAdapter;
  }

  // 2. $falcon.jsapi.storage 等宿主对象
  const stores = candidateStores();
  for (let i = 0; i < stores.length; i++) {
    try {
      const adapter = buildAdapter(stores[i]);
      if (adapter) {
        logDiag('存储就绪: $falcon.jsapi.storage');
        storageAdapter = adapter;
        adapterReady = true;
        return storageAdapter;
      }
    } catch (e) {
      // 继续尝试下一个候选
    }
  }

  // 3. import('storage') 模块
  try {
    const mod = await import('storage');
    const s = mod && mod.default ? mod.default : mod;
    const adapter = buildAdapter(s);
    if (adapter) {
      logDiag('存储就绪: import(storage)');
      storageAdapter = adapter;
      adapterReady = true;
      return storageAdapter;
    }
  } catch (e) {
    // 继续下一级
  }
  logDiag('!! 无持久化存储，退到内存 Map（退出即失忆）');

  // 4. 内存兜底（不落盘，仅保证开发期可用）
  storageAdapter = {
    getItem: (key) => Promise.resolve(memoryStore.get(normalizeKey(key)) || null),
    setItem: (key, value) => Promise.resolve(memoryStore.set(normalizeKey(key), String(value))),
    removeItem: (key) => Promise.resolve(memoryStore.delete(normalizeKey(key))),
  };
  adapterReady = true;
  return storageAdapter;
}

// 是否已落到真实存储（false = 内存兜底，退出即失忆，UI 可据此提示）。
// 注意：必须在任意 getItem/setItem 之后调用——探测是异步的，此前 adapter 尚未就绪。
export function isPersistent() {
  return !!(storageAdapter && storageAdapter.persistent);
}

// 存储往返自检：写入探针 → 读回比对 → 清理。
// 只探测 API 是否存在不够——真机上可能 API 在但写入静默失败，
// 那种情况下「退出即失忆」会毫无征兆。返回 Promise<boolean>。
let selfTestResult = null;
export function selfTest() {
  if (selfTestResult !== null) return Promise.resolve(selfTestResult);
  const probeKey = '__deepseek_probe__';
  const probeVal = 'ok' + String(Date.now ? Date.now() : 0); // 纯 ASCII，避免编码干扰
  return setItem(probeKey, probeVal)
    .then(() => {
      logDiag('自检: 已写入 ' + probeKey + '=' + probeVal);
      return getItem(probeKey);
    })
    .then((back) => {
      logDiag('自检: 读回=' + describe(back) + ' 期望=' + probeVal);
      selfTestResult = String(back) === probeVal;
      return removeItem(probeKey).then(
        () => {
          logDiag('自检结论: ' + (selfTestResult ? '可持久化 ✅' : '读回不匹配 ❌'));
          return selfTestResult;
        },
        () => selfTestResult
      );
    })
    .catch((e) => {
      logDiag('自检异常: ' + (e && e.message ? e.message : String(e)));
      selfTestResult = false;
      return false;
    });
}

export async function getItem(key, fallback) {
  const adapter = await detectAdapter();
  const value = await adapter.getItem(normalizeKey(key));
  return value == null ? (fallback === undefined ? null : fallback) : value;
}

export async function setItem(key, value) {
  const adapter = await detectAdapter();
  return adapter.setItem(normalizeKey(key), String(value));
}

export async function removeItem(key) {
  const adapter = await detectAdapter();
  return adapter.removeItem(normalizeKey(key));
}

// ---------- 串行化写入链 ----------
let writeChain = Promise.resolve();

function enqueueWrite(task) {
  const next = writeChain.then(task, task);
  // 吞掉错误避免污染整条链
  writeChain = next.catch(() => {});
  return next;
}

export function setJson(key, data) {
  const payload = JSON.stringify({ version: SCHEMA_VERSION, data: data === undefined ? null : data });
  return enqueueWrite(() => setItem(key, payload));
}

export async function getJson(key, fallback) {
  try {
    const raw = await getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === SCHEMA_VERSION) {
      return parsed.data;
    }
    return fallback;
  } catch (e) {
    return fallback;
  }
}

export function removeJson(key) {
  return enqueueWrite(() => removeItem(key));
}
