// 全局配置。
//
// **不内置 API Key 与端点**：两者都必须由用户在设置里填写，首次使用前
// 应用不具备可用配置（见 services/deepseek-api.js 的 isConfigured）。
// 运行期从设备存储读取，见 resolveApiKey / resolveApiBaseUrl。

const CONFIG = {
  appid: '8000000000009871',

  // 端点与密钥：**留空**，由用户在设置页填写并存入设备
  apiBaseUrl: '',
  apiKey: '',

  // 模型名：仅作用于请求体的 model 字段。可在设置页覆盖（不同服务商命名不同，
  // 如 deepseek-chat / gpt-4o-mini / qwen-plus）。这里是内置默认值。
  model: 'deepseek-chat',
  requestTimeoutMs: 30000,
  maxTokens: 4096,

  // 设备探测失败时的兜底逻辑宽度（px）；UI 一律用 rpx，按 viewport 自动缩放
  fallbackViewportWidth: 360,
  fallbackViewportHeight: 640,

  // 本地历史（落盘在 <app 私有 data 目录>/deepseek_store.json）
  // storageKey 是 v1 的单条历史（已废弃，仅用于启动时迁移到 sessionsKey）
  storageKey: 'deepseek_chat_history_v1',
  // 多会话存储（v2）：{ activeId, sessions: [{id,title,messages,ts}] }
  sessionsKey: 'deepseek_sessions_v2',
  // 最多保留的会话数（超出时丢弃最旧的，防止存储无限膨胀）
  maxSessions: 30,
  // 最多保留的消息条数（user+assistant 各算一条）
  storageMaxItems: 60,
  // 单次请求携带的上下文 token 预算（超出则从最旧的轮次开始丢弃）。
  // deepseek-chat 上下文 64K，这里保守取 24K：留给回复 + 系统提示，
  // 也避免词典笔上一次性传输过大 JSON。
  contextTokenBudget: 24000,
};

export default CONFIG;