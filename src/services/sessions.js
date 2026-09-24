// 多会话管理。
//
// 存储结构（键 CONFIG.sessionsKey）：
//   {
//     version: 2,
//     activeId: 's_...',
//     sessions: [
//       { id, title, messages: [{role,content}], ts }
//     ]
//   }
//
// 从 v1（单一历史 deepseek_chat_history_v1）自动迁移：旧记录作为第一个会话。
//
// 设计取舍：
//   · 会话按更新时间倒序排列，最近用的在最前（列表里一眼能看到）
//   · 标题取首条用户消息的前若干字，无需用户手动命名
//   · 空会话（没发过消息的）不落盘，避免用户连点「新建」攒一堆空壳

import CONFIG from '../config.js';
import { getJson, setJson, removeJson } from './storage.js';

let seq = 0;

function newId() {
  // 不用 Math.random（QuickJS 上行为不确定）：时间戳 + 递增序号足够唯一
  const t = Date.now ? Date.now() : 0;
  seq = (seq + 1) % 100000;
  return 's' + String(t) + '_' + String(seq);
}

function now() {
  return Date.now ? Date.now() : 0;
}

// 标题：取首条用户消息，截断到 18 字（窄屏列表一行放得下）
export function deriveTitle(messages) {
  if (!Array.isArray(messages)) return '新对话';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      const s = m.content.trim().replace(/\s+/g, ' ');
      return s.length > 18 ? s.slice(0, 18) + '…' : s;
    }
  }
  return '新对话';
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter((m) => m && typeof m.content === 'string' && m.content)
    : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    title: typeof raw.title === 'string' && raw.title ? raw.title : deriveTitle(messages),
    messages,
    ts: typeof raw.ts === 'number' ? raw.ts : 0,
  };
}

function sortSessions(list) {
  return list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export function emptySession() {
  return { id: newId(), title: '新对话', messages: [], ts: now() };
}

// 读取全部会话；含 v1 → v2 迁移。返回 { activeId, sessions }
export async function loadSessions() {
  // 1) 现有 v2 数据
  const v2 = await getJson(CONFIG.sessionsKey, null);
  if (v2 && Array.isArray(v2.sessions)) {
    const sessions = v2.sessions.map(normalizeSession).filter(Boolean);
    if (sessions.length) {
      const activeId = sessions.some((s) => s.id === v2.activeId) ? v2.activeId : sortSessions(sessions)[0].id;
      return { activeId, sessions: sortSessions(sessions) };
    }
  }

  // 2) 从 v1 迁移（旧的单条历史 → 一个会话）
  const legacy = await getJson(CONFIG.storageKey, null);
  if (Array.isArray(legacy) && legacy.length) {
    const msgs = legacy.filter((m) => m && typeof m.content === 'string' && m.content && !m.isError);
    if (msgs.length) {
      const s = { id: newId(), title: deriveTitle(msgs), messages: msgs, ts: now() };
      const data = { activeId: s.id, sessions: [s] };
      setJson(CONFIG.sessionsKey, data);
      removeJson(CONFIG.storageKey); // 迁移完成后清掉旧键，避免重复迁移
      return { activeId: s.id, sessions: [s] };
    }
  }

  // 3) 全新：建一个空会话（先不落盘，等用户发消息时再存）
  const s = emptySession();
  return { activeId: s.id, sessions: [s] };
}

// 保存会话列表（过滤掉空会话；若全空则保留当前活动会话占位）
export async function saveSessions(activeId, sessions) {
  const keep = (sessions || []).filter((s) => s && s.messages && s.messages.length);
  const data = { activeId, sessions: keep };
  return setJson(CONFIG.sessionsKey, data);
}
