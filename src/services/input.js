// 系统输入法封装（global.startTextEdit 路径）。
//
// 状态机说明（与 native 端约定一致）：
//   1. openTextEditor() 调用 global.startTextEdit(JSON.stringify(config))，拿到会话 UUID
//   2. 输入法回调 textEditFinished(uuid, jsonStr)；仅当 editConfirmed === true 才视为确认
//   3. closeTextEditSession() / 过期 UUID 一律丢弃，保证幂等
//   4. 页面卸载时调用 releaseInput()，注销事件、关闭未结束会话

// 真机 falcon 运行时 'global' 只提供默认导出（对象含 Global 类），必须 default import：
//   import globalModule from 'global' → new globalModule.Global()
// 具名 import { Global } 会抛 SyntaxError: Could not find export 'Global'，导致 app 启动崩溃黑屏。
// 开发期由 api-mock/global.js 提供（其同时导出 default 与具名，双兼容）。
import globalModule from 'global';

let manager = null;
let eventBound = false;
let activeUuid = null;
let activeResolver = null;

function getManager() {
  if (!manager) manager = new globalModule.Global();
  return manager;
}

function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  return String(value);
}

function onTextEditFinished(uuid, payload) {
  // 只处理当前会话；过期事件直接忽略
  if (!activeUuid || uuid !== activeUuid) return;
  const resolver = activeResolver;
  // 先清会话，再进入回调，避免回调里再开新会话时互相覆盖
  resetSession();

  let confirmed = false;
  let text = '';
  try {
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    confirmed = obj && obj.editConfirmed === true;
    text = normalizeText(obj ? obj.text : payload);
  } catch (e) {
    confirmed = false;
    text = '';
  }
  if (resolver) resolver(confirmed ? text : null);
}

function resetSession() {
  activeUuid = null;
  activeResolver = null;
}

// 呼起系统输入法，resolve(text) 表示确认输入，resolve(null) 表示取消/超时
export function openTextEditor(config) {
  const g = getManager();
  if (!eventBound) {
    g.textEditFinished.on(onTextEditFinished);
    eventBound = true;
  }
  // 关闭上一次未结束的会话
  if (activeUuid) {
    try {
      g.closeTextEdit(activeUuid);
    } catch (e) {
      // 忽略：旧会话可能已被系统回收
    }
    resetSession();
  }

  let uuid = null;
  try {
    uuid = g.startTextEdit(JSON.stringify(config));
  } catch (e) {
    return Promise.reject(new Error('startTextEdit failed: ' + e.message));
  }
  activeUuid = uuid;
  return new Promise((resolve) => {
    activeResolver = resolve;
  });
}

// 主动关闭当前输入会话（页面隐藏/卸载时调用）
export function closeTextEditSession() {
  if (!manager || !activeUuid) return;
  try {
    manager.closeTextEdit(activeUuid);
  } catch (e) {
    // 忽略
  }
  resetSession();
}

// 释放全部资源：注销事件、关闭会话
export function releaseInput() {
  if (!manager) return;
  closeTextEditSession();
  if (eventBound) {
    try {
      manager.textEditFinished.off(onTextEditFinished);
    } catch (e) {
      // 忽略
    }
    eventBound = false;
  }
}

// 常用输入法配置（多行 + 发送键）
export function defaultTextEditConfig(opts) {
  const defaults = {
    title: '发送给 YDAgent',
    editType: 1, // 1 = 文本
    multiLinesEditVisible: true,
    enterButtonText: '发送',
    maxBytes: 4000,
    initialText: '',
  };
  const merged = {};
  Object.keys(defaults).forEach((k) => {
    merged[k] = opts && opts[k] !== undefined ? opts[k] : defaults[k];
  });
  if (opts && typeof opts.initialText === 'string') merged.initialText = opts.initialText;
  return merged;
}