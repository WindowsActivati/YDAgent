// 屏幕适配：从 /etc/miniapp/resources/cfg.json 读取物理宽高，
// 换算成 setViewPort 所需的逻辑宽度。
//
// 取值顺序（逐级兜底）：
//   1. native deepseek.getDeviceConfig() —— 直接读设备 cfg.json（同步）
//   2. $falcon.env（部分固件暴露 screen 信息）
//   3. 内置兜底值（config.fallbackViewportWidth）
//
// UI 一律使用 rpx，因此这里只要拿到“宽度”，rpx 跟着 viewport 自适应。

import CONFIG from '../config.js';
import { DeepSeek } from 'deepseek'; // native 模块；未安装时由 api-mock 兜底

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return fallback;
}

// 在解析结果里递进查找形如 {width, height} 的屏幕对象，
// 兼容 screen/screenSize/display/screenWidth 等常见字段名。
function findScreen(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const candidates = [];
  const stack = [cfg];
  const seen = new Set();
  while (stack.length && candidates.length < 8) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) stack.push(node[i]);
      continue;
    }
    const w = node.width;
    const h = node.height;
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      candidates.push({ width: w, height: h });
    }
    Object.keys(node).forEach((k) => {
      const key = String(k).toLowerCase();
      if (/^(screen|display|screenSize|resolution|cfg|config|window|ui)$/.test(key)) {
        stack.push(node[k]);
      } else if (/^(width|height|screenWidth|screenHeight|w|h)$/.test(key)) {
        // 只收集，不深挖到原始值对象
        const v = node[k];
        if (typeof v === 'number') candidates.push({ [key]: v });
      }
    });
  }
  // 优先挑同时含 width+height 的候选
  const full = candidates.find((c) => typeof c.width === 'number' && typeof c.height === 'number');
  if (full) return full;
  return null;
}

function readFromEnv() {
  const env = (typeof $falcon !== 'undefined' && $falcon.env) || {};
  const w = env.screenWidth != null ? env.screenWidth : env.width;
  const h = env.screenHeight != null ? env.screenHeight : env.height;
  if (w != null && h != null) return { width: clampInt(w, 120, 4096, 0), height: clampInt(h, 120, 4096, 0) };
  if (w != null) return { width: clampInt(w, 120, 4096, 0), height: 0 };
  return null;
}

function parseCfgJson(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return null;
  try {
    const json = JSON.parse(raw);
    return findScreen(json);
  } catch (e) {
    return null;
  }
}

function readFromNative() {
  try {
    if (typeof DeepSeek.getDeviceConfig !== 'function') return null;
    const raw = DeepSeek.getDeviceConfig();
    return parseCfgJson(raw);
  } catch (e) {
    return null;
  }
}

// 返回 { width, height }，width 恒大于 0，height 可能为 0
export function resolveScreen() {
  const fromNative = readFromNative();
  if (fromNative && fromNative.width) return fromNative;
  const fromEnv = readFromEnv();
  if (fromEnv && fromEnv.width) return fromEnv;
  return {
    width: CONFIG.fallbackViewportWidth,
    height: CONFIG.fallbackViewportHeight,
  };
}

// App.onLaunch 调用：返回 setViewPort 的宽度
export function resolveViewportWidth() {
  const screen = resolveScreen();
  // 若屏幕为横向（宽>高），词典笔场景按物理宽度展示
  return screen.width;
}

// 供页面自定义（切换横竖屏时重新计算）
export function viewportSize() {
  return resolveScreen();
}