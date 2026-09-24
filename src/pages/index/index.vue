<template>
  <view class="root">
    <!-- ===================== 聊天页 ===================== -->
    <view class="chat-page" v-if="!settingsOpen && !confirmCmd">
    <!-- 顶部栏 -->
    <view class="header">
      <!-- 菜单键：打开会话列表 / 新建对话 -->
      <view class="menu-btn" activeClass="menu-btn-active" @click="onOpenMenu">
        <view class="menu-line"></view>
        <view class="menu-line menu-line-mid"></view>
        <view class="menu-line"></view>
      </view>
      <view class="header-title-wrap">
        <text class="header-title">YDAgent</text>
        <text class="header-sub">{{ activeTitle }}</text>
      </view>
      <view class="header-clear" activeClass="header-clear-active" @click="onClear">
        <text class="header-clear-text">清空</text>
      </view>
    </view>

    <!-- 存储不可用提示 -->
    <view class="storage-warn" v-if="storageWarning">
      <text class="storage-warn-text">{{ storageWarning }}</text>
    </view>

    <!-- 消息列表 -->
    <scroller class="msg-list" ref="list">
      <view class="msg-empty" v-if="!messages.length && !thinking">
        <view class="empty-badge">
          <text class="empty-badge-text">Y</text>
        </view>
        <text class="msg-empty-title">你好，我是 YDAgent</text>
        <text class="msg-empty-desc" v-if="configured">点下方输入框，用系统输入法提问</text>
        <text class="msg-empty-desc" v-else>先去设置里填写 API Key 和请求端点</text>
      </view>

      <view class="msg-row" v-for="(m, index) in messages" :key="index">
        <!-- 用户：右对齐橙色气泡 -->
        <view class="bubble-user" v-if="m.role === 'user'">
          <text class="bubble-user-text">{{ m.content }}</text>
        </view>
        <!-- 命令执行记录：等宽深色块，与普通回答区分开 -->
        <view class="bubble-ai-command" v-else-if="m.isCommand">
          <text class="bubble-ai-command-text">{{ m.content }}</text>
        </view>
        <!-- AI：左对齐卡片气泡 -->
        <view class="bubble-ai" v-else>
          <text class="bubble-ai-text">{{ m.content }}</text>
          <!-- 流式光标：仅当前正在输出的那条 -->
          <text class="stream-cursor" v-if="streamingCursor && index === messages.length - 1">▍</text>
        </view>
      </view>

      <!-- 等待首个 token：只在还没有任何流式内容时显示（有内容后由气泡本身呈现） -->
      <view class="msg-row" v-if="thinking && !hasStreamingText">
        <view class="bubble-ai">
          <view class="thinking-dots">
            <view class="thinking-dot thinking-dot-1"></view>
            <view class="thinking-dot thinking-dot-2"></view>
            <view class="thinking-dot thinking-dot-3"></view>
          </view>
        </view>
      </view>
    </scroller>

    <!-- 底部输入区 -->
    <view class="input-bar">
      <view class="settings-btn" activeClass="settings-btn-active" @click="onOpenSettings">
        <text class="settings-icon">⚙</text>
      </view>
      <view class="input-box" activeClass="input-box-active" @click="onTapInput">
        <text class="input-placeholder" v-if="!draftText">输入问题…</text>
        <text class="input-text" v-else>{{ draftText }}</text>
      </view>
      <view class="send-btn" activeClass="send-btn-active" @click="onSend">
        <text class="send-btn-text">发送</text>
      </view>
    </view>
    </view>

    <!-- ===================== 会话抽屉 =====================
         从左滑出，右侧露着聊天页（不是整页替换）。
         用 position:absolute 而非 fixed —— 这台设备上 fixed 覆盖层渲染不可靠；
         absolute 相对 .root（100%×100%）定位，同样铺满但不依赖 fixed 语义。
         滑入用 @keyframes（nvue 不支持 CSS transition）。 -->
    <view class="drawer-mask" v-if="menuOpen" @click="onCloseMenu"></view>
    <view class="drawer" v-if="menuOpen">
      <view class="drawer-header">
        <text class="drawer-title">对话</text>
        <view class="new-btn" activeClass="new-btn-active" @click="onNewSession">
          <text class="new-btn-text">+ 新建</text>
        </view>
      </view>

      <scroller class="drawer-body">
        <view
          class="sess-row"
          :activeClass="'sess-row-active'"
          v-for="s in sessions"
          :key="s.id"
          @click="onSwitchSession(s.id)"
        >
          <view class="sess-main">
            <text class="sess-title" :class="{ 'sess-title-active': s.id === activeId }">{{ s.title }}</text>
            <text class="sess-sub">{{ sessionSub(s) }}</text>
          </view>
          <view class="sess-del" activeClass="sess-del-active" @click="onDeleteSession(s.id)">
            <text class="sess-del-text">删</text>
          </view>
        </view>

        <view class="sess-empty" v-if="!sessions.length">
          <text class="sess-empty-text">还没有对话，点上方新建</text>
        </view>
      </scroller>
    </view>

    <!-- ===================== 命令授权页 =====================
         AI 提议执行 shell 命令时必须经用户逐条确认。这是唯一的执行闸门，
         不能被绕过——任何"自动放行"改动都等于把 root 权限交给模型。 -->
    <view class="settings-page" v-if="confirmCmd">
      <view class="settings-header">
        <text class="settings-title">执行命令？</text>
        <view class="danger-badge" v-if="confirmDangers.length">
          <text class="danger-badge-text">危险</text>
        </view>
      </view>

      <scroller class="settings-body">
        <text class="field-label" v-if="confirmReason">AI 的理由</text>
        <text class="confirm-reason" v-if="confirmReason">{{ confirmReason }}</text>

        <text class="field-label field-label-gap">将要执行</text>
        <view class="cmd-box">
          <text class="cmd-text">{{ confirmCmd }}</text>
        </view>

        <!-- 危险命令：红字警告，但仍允许执行（用户可保留高级操作自由） -->
        <view class="danger-note" v-if="confirmDangers.length">
          <text class="danger-note-title">⚠ 这条命令有风险</text>
          <text class="danger-note-item" v-for="(d, i) in confirmDangers" :key="i">· {{ d }}</text>
        </view>
      </scroller>

      <view class="confirm-actions">
        <view class="deny-btn" activeClass="deny-btn-active" @click="onDenyCommand">
          <text class="deny-btn-text">拒绝</text>
        </view>
        <view
          class="allow-btn"
          :activeClass="'allow-btn-active'"
          :class="{ 'allow-btn-danger': confirmDangers.length > 0 }"
          @click="onAllowCommand"
        >
          <text class="allow-btn-text">允许执行</text>
        </view>
      </view>
    </view>

    <!-- ===================== 设置页 =====================
         整页替换而非覆盖层：nvue 的 position:fixed + z-index 在这台设备上
         渲染错乱（与聊天页重叠、退不出去）。改为同时只渲染一个页面。
         注意：这里用显式 v-if 而不是 v-else——上面插入了命令授权页，
         v-else 会错误地绑定到它的条件上。 -->
    <view class="settings-page" v-if="settingsOpen">
      <view class="settings-header">
        <text class="settings-title">设置</text>
        <view class="settings-done" activeClass="settings-done-active" @click="onCloseSettings">
          <text class="settings-done-text">完成</text>
        </view>
      </view>

      <!-- 内容可滚动：屏幕很矮（170 高），设置项放不下，不滚就点不到上面的项 -->
      <scroller class="settings-body">
        <text class="field-note" v-if="!settings.configured">两项都填写后才能开始对话</text>

        <!-- API Key -->
        <text class="field-label">API Key</text>
        <view class="field-box" activeClass="field-box-active" @click="onEditApiKey">
          <text class="field-value" v-if="settings.apiKey">{{ maskedApiKey }}</text>
          <text class="field-placeholder" v-else>点击填写</text>
        </view>
        <text class="field-hint" v-if="settings.hasKey">已设置</text>
        <text class="field-hint" v-else>尚未设置</text>

        <!-- API 请求端点 -->
        <text class="field-label field-label-gap">API 请求端点</text>
        <view class="field-box" activeClass="field-box-active" @click="onEditApiBase">
          <text class="field-value" v-if="settings.apiBaseUrl">{{ settings.apiBaseUrl }}</text>
          <text class="field-placeholder" v-else>点击填写</text>
        </view>
        <text class="field-hint" v-if="settings.hasBase">已设置</text>
        <text class="field-hint" v-else>尚未设置</text>

        <!-- 清除配置 -->
        <view class="reset-btn" activeClass="reset-btn-active" @click="onClearSettings">
          <text class="reset-btn-text">清除配置</text>
        </view>
      </scroller>
    </view>
  </view>
</template>

<script>
import api from '../../services/deepseek-api.js';
import { openTextEditor, closeTextEditSession, releaseInput, defaultTextEditConfig } from '../../services/input.js';
import { selfTest, logDiag } from '../../services/storage.js';
import { loadSessions, saveSessions, emptySession, deriveTitle } from '../../services/sessions.js';
import { runWithTools } from '../../services/agent.js';
import CONFIG from '../../config.js';

// 诊断输出（app 内 console 不进设备日志，统一走 native 落盘到 /tmp/deepseek_diag.log）
function diag(msg) {
  logDiag('[chat] ' + msg);
}

export default {
  name: 'index',

  data() {
    return {
      messages: [],
      draftText: '',
      thinking: false,
      destroyed: false,
      generation: 0,
      historyLoaded: false,
      historyLoading: false,
      // 存储不可用时提示用户（否则「退出即失忆」会让人困惑）
      storageWarning: '',
      // 设置面板
      settingsOpen: false,
      settings: {
        apiKey: '',
        apiBaseUrl: '',
        hasKey: false,
        hasBase: false,
        configured: false,
      },
      // 是否已完成配置（未配置时输入框点击会引导去设置）
      configured: false,
      // 多会话
      menuOpen: false,
      sessions: [],
      activeId: '',
      // 命令授权（AI 每次要执行命令都会填这里并弹出确认页）
      confirmCmd: '',
      confirmReason: '',
      confirmDangers: [],
      _confirmResolve: null,
    };
  },

  computed: {
    // 是否已有流式内容进来（用于决定"思考中"动画是否该收起）
    hasStreamingText() {
      const last = this.messages.length ? this.messages[this.messages.length - 1] : null;
      return !!(last && last.role === 'assistant' && last.content && !last.isError);
    },
    // 当前是否正在逐字输出（用于在气泡末尾显示闪烁光标）
    streamingCursor() {
      if (!this.thinking) return false;
      const last = this.messages.length ? this.messages[this.messages.length - 1] : null;
      return !!(last && last.role === 'assistant' && last.content);
    },
    // API Key 掩码显示：保留头尾，中间打点（设置面板里不完整暴露密钥）
    maskedApiKey() {
      const k = String(this.settings.apiKey || '');
      if (!k) return '';
      if (k.length <= 12) return k.slice(0, 4) + '····';
      return k.slice(0, 7) + '····' + k.slice(-4);
    },
    // 顶栏副标题显示当前会话标题（让用户知道自己在哪条对话里）
    activeTitle() {
      const s = this.sessions.find((x) => x.id === this.activeId);
      return (s && s.title) || '词典笔 AI 助手';
    },
  },

  onLoad() {},

  // 注意：不要依赖 falcon 的 onShow 来加载历史。
  // 实测它没有被触发（诊断日志里 loadHistory 的自检输出从未出现），
  // 导致历史既不加载也不报错——「每次打开都失忆」的直接原因。
  // Vue 的 mounted 由 nvue 框架保证调用，用它做主入口。
  mounted() {
    this.loadHistory();
  },

  onShow() {
    // 仅在 mounted 未生效时兜底；historyLoaded 守卫避免重复加载覆盖当前对话
    if (!this.historyLoaded) this.loadHistory();
  },

  onHide() {
    // 页面不可见时关闭输入会话，避免残留
    closeTextEditSession();
  },

  onUnload() {
    this.destroyed = true;
    this.generation += 1;
    releaseInput();
  },

  beforeDestroy() {
    this.destroyed = true;
    this.generation += 1;
    releaseInput();
  },

  methods: {
    async loadHistory() {
      if (this.historyLoading || this.historyLoaded) return;
      this.historyLoading = true;
      try {
        diag('loadSessions 开始');
        // 先做写入-读回自检：只有真能落盘才算可用
        const ok = await selfTest();
        if (!ok) {
          this.storageWarning = '本地存储不可用，本次对话不会保存';
        }
        await this.refreshSettings(); // 先同步配置状态（未配置时首页给引导）
        const data = await loadSessions();
        this.sessions = data.sessions;
        this.activeId = data.activeId;
        const cur = this.sessions.find((s) => s.id === this.activeId);
        const msgs = cur && Array.isArray(cur.messages) ? cur.messages.filter((m) => m && !m.isError) : [];
        diag('载入 ' + this.sessions.length + ' 个会话，当前 ' + msgs.length + ' 条消息');
        if (msgs.length) {
          this.messages = msgs;
          this.scrollToBottom();
        }
      } catch (e) {
        diag('loadSessions 异常: ' + (e && e.message ? e.message : String(e)));
      } finally {
        this.historyLoaded = true;
        this.historyLoading = false;
      }
    },

    scrollToBottom() {
      this.$nextTick(() => {
        if (this.destroyed) return;
        const list = this.$refs.list;
        if (list && typeof list.scrollToBottom === 'function') {
          try {
            list.scrollToBottom();
          } catch (e) {
            // 忽略滚动异常
          }
        }
      });
    },

    async onTapInput() {
      if (this.thinking) return;
      const text = await openTextEditor(
        defaultTextEditConfig({ initialText: this.draftText || '' })
      ).catch(() => null);
      if (this.destroyed || text == null) return;
      if (!text.trim()) return;
      this.draftText = text;
      // 按“发送”键确认：直接发出
      this.onSend();
    },

    async onSend() {
      if (this.thinking || this.destroyed) return;
      const content = String(this.draftText || '').trim();
      if (!content) return;

      this.messages.push({ role: 'user', content });
      this.draftText = '';
      this.scrollToBottom();

      const gen = ++this.generation;
      this.thinking = true;

      // 流式：先放一个空气泡，增量往里追加（Vue2 对已存在属性赋值是响应式的）
      const bubble = { role: 'assistant', content: '' };
      this.messages.push(bubble);
      const idx = this.messages.length - 1;
      this.scrollToBottom();

      // 滚动节流：增量可能每几十毫秒一次，每次都滚会拖慢渲染
      let lastScroll = 0;
      const onDelta = (text) => {
        if (this.destroyed || gen !== this.generation) return; // 过期请求的增量丢弃
        const m = this.messages[idx];
        if (m !== bubble) return; // 气泡已被替换（理论上不会）
        m.content += text;
        const now = Date.now();
        if (now - lastScroll > 120) {
          lastScroll = now;
          this.scrollToBottom();
        }
      };

      try {
        // 走 agent 循环：模型可以请求执行命令，每条都要用户确认。
        // 模型调用工具时输出的说明文字作为独立气泡展示，最终回答写进 bubble。
        const reply = await runWithTools(
          this.messages.filter((m) => m !== bubble), // 不含空气泡
          {
            signal: { aborted: this.destroyed || gen !== this.generation },
            onAssistantText: (text) => {
              if (this.destroyed || gen !== this.generation) return;
              if (text && text.trim()) {
                // 插到当前气泡之前（保持时序：先说话，后执行命令）
                const at = this.messages.indexOf(bubble);
                this.messages.splice(at < 0 ? this.messages.length : at, 0, {
                  role: 'assistant',
                  content: text,
                });
                this.scrollToBottom();
              }
            },
            onConfirm: (info) => this.askCommandPermission(info),
            onCommandStart: (info) => {
              if (this.destroyed || gen !== this.generation) return;
              const at = this.messages.indexOf(bubble);
              this.messages.splice(at < 0 ? this.messages.length : at, 0, {
                role: 'assistant',
                content: '执行命令：' + info.command,
                isCommand: true,
              });
              this.scrollToBottom();
            },
            onCommandEnd: (info) => {
              if (this.destroyed || gen !== this.generation) return;
              const r = info.result || {};
              const head = '输出' + (r.code === 0 ? '' : '（退出码 ' + r.code + '）') + '：';
              const body = (r.output || '(无输出)').slice(0, 1200);
              const at = this.messages.indexOf(bubble);
              this.messages.splice(at < 0 ? this.messages.length : at, 0, {
                role: 'assistant',
                content: head + '\n' + body,
                isCommand: true,
              });
              this.scrollToBottom();
            },
          }
        );
        if (this.destroyed || gen !== this.generation) return;
        bubble.content = reply;
      } catch (e) {
        if (this.destroyed || gen !== this.generation) return;
        const msg = e && e.message ? e.message : '请求失败，请稍后重试';
        // 未配置：撤掉这个气泡，改为引导用户去设置（不是错误，是还没设置好）
        if (e && e.code === api.NOT_CONFIGURED) {
          const bi = this.messages.indexOf(bubble);
          if (bi >= 0) this.messages.splice(bi, 1);
          this.warn(api.NOT_CONFIGURED_MSG);
          diag('未配置，已引导去设置页');
          this.onOpenSettings();
          return;
        }
        if (bubble.content) {
          bubble.isError = true; // 已吐出部分内容：保留并标注中断
          diag('流式中断（已收到 ' + bubble.content.length + ' 字）: ' + msg);
        } else {
          bubble.content = '⚠ ' + msg;
          bubble.isError = true;
        }
      } finally {
        if (!this.destroyed && gen === this.generation) {
          this.thinking = false;
          this.scrollToBottom();
          this.persistHistory();
        }
      }
    },

    // ---------- 命令授权 ----------
    // 显示确认页并等待用户决定。返回 Promise<boolean>。
    // ⚠ 这是命令执行的唯一闸门：runWithTools 里的任何命令都会经过这里。
    askCommandPermission(info) {
      return new Promise((resolve) => {
        this.confirmCmd = info.command;
        this.confirmReason = info.reason || '';
        this.confirmDangers = info.dangers || [];
        this._confirmResolve = resolve;
        diag('待授权命令: ' + info.command + (this.confirmDangers.length ? '（危险）' : ''));
      });
    },

    onAllowCommand() {
      const r = this._confirmResolve;
      this._confirmResolve = null;
      this.confirmCmd = '';
      this.confirmReason = '';
      this.confirmDangers = [];
      diag('用户允许执行');
      if (r) r(true);
    },

    onDenyCommand() {
      const r = this._confirmResolve;
      this._confirmResolve = null;
      this.confirmCmd = '';
      this.confirmReason = '';
      this.confirmDangers = [];
      diag('用户拒绝执行');
      if (r) r(false);
    },

    // 把当前消息写回活动会话，并按时间倒序落盘（空会话不落盘）
    persistHistory() {
      // 只存最近若干条，且不落盘错误气泡（下次打开时它们没有意义）
      const clean = this.messages.filter((m) => m && !m.isError);
      const keep = clean.slice(-CONFIG.storageMaxItems);

      let idx = this.sessions.findIndex((s) => s.id === this.activeId);
      if (idx < 0) {
        // 活动会话不在列表里（理论上不该发生）：补一个
        const s = emptySession();
        s.id = this.activeId;
        this.sessions.push(s);
        idx = this.sessions.length - 1;
      }
      const cur = this.sessions[idx];
      cur.messages = keep;
      cur.title = deriveTitle(keep);
      cur.ts = Date.now ? Date.now() : 0;

      // 按更新时间倒序，超出上限的丢最旧的（保护存储）
      this.sessions = this.sessions
        .slice()
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, CONFIG.maxSessions);

      diag('保存会话 ' + keep.length + ' 条（共 ' + this.sessions.length + ' 个）');
      saveSessions(this.activeId, this.sessions).then(
        () => diag('会话已写入'),
        (e) => diag('会话写入失败: ' + (e && e.message ? e.message : String(e)))
      );
    },

    // 清空当前会话的消息（保留这个会话本身）
    onClear() {
      this.generation += 1;
      this.thinking = false;
      this.messages = [];
      this.draftText = '';
      const idx = this.sessions.findIndex((s) => s.id === this.activeId);
      if (idx >= 0) {
        this.sessions[idx].messages = [];
        this.sessions[idx].title = '新对话';
        // 从列表里移除（空会话不保留），然后开一个新的顶上
        this.sessions.splice(idx, 1);
      }
      const s = emptySession();
      this.sessions.unshift(s);
      this.activeId = s.id;
      saveSessions(this.activeId, this.sessions).then(
        () => diag('已清空并新建会话'),
        (e) => diag('清空失败: ' + (e && e.message ? e.message : String(e)))
      );
    },

    // ---------- 会话列表 ----------

    onOpenMenu() {
      this.menuOpen = true;
    },

    onCloseMenu() {
      this.menuOpen = false;
    },

    // 列表里的副标题：消息条数
    sessionSub(s) {
      const n = s && Array.isArray(s.messages) ? s.messages.length : 0;
      if (!n) return '空对话';
      return n + ' 条消息' + (s.id === this.activeId ? ' · 当前' : '');
    },

    // 新建对话：把有内容的旧会话留在列表里，开一个新的并切过去
    onNewSession() {
      this.generation += 1;
      this.thinking = false;
      // 先把当前进度存下（否则刚聊的内容会丢）
      if (this.messages.filter((m) => m && !m.isError).length) this.persistHistory();

      const s = emptySession();
      this.sessions = [s].concat(this.sessions);
      this.activeId = s.id;
      this.messages = [];
      this.draftText = '';
      this.menuOpen = false;
      diag('新建会话 ' + s.id);
      saveSessions(this.activeId, this.sessions);
    },

    // 切换会话
    onSwitchSession(id) {
      if (id === this.activeId) {
        this.menuOpen = false;
        return;
      }
      this.generation += 1;
      this.thinking = false;
      if (this.messages.filter((m) => m && !m.isError).length) this.persistHistory();

      this.activeId = id;
      const s = this.sessions.find((x) => x.id === id);
      this.messages = s && Array.isArray(s.messages) ? s.messages.filter((m) => m && !m.isError) : [];
      this.draftText = '';
      this.menuOpen = false;
      this.scrollToBottom();
      diag('切换会话 ' + id + '（' + this.messages.length + ' 条）');
      saveSessions(this.activeId, this.sessions);
    },

    // 删除会话
    onDeleteSession(id) {
      const idx = this.sessions.findIndex((s) => s.id === id);
      if (idx < 0) return;
      this.sessions.splice(idx, 1);

      if (id === this.activeId) {
        // 删的是当前会话：退到下一个可用的，没有就新建一个空的
        this.generation += 1;
        this.thinking = false;
        const next = this.sessions[0];
        if (next) {
          this.activeId = next.id;
          this.messages = Array.isArray(next.messages) ? next.messages.filter((m) => m && !m.isError) : [];
        } else {
          const s = emptySession();
          this.sessions = [s];
          this.activeId = s.id;
          this.messages = [];
        }
        this.draftText = '';
      }
      diag('删除会话 ' + id);
      saveSessions(this.activeId, this.sessions);
    },

    // ---------- 设置页 ----------

    async refreshSettings() {
      try {
        const s = await api.resolveSettings();
        this.settings = {
          apiKey: s.apiKey,
          apiBaseUrl: s.apiBaseUrl,
          hasKey: s.hasKey,
          hasBase: s.hasBase,
          configured: s.configured,
        };
        this.configured = s.configured;
      } catch (e) {
        diag('读取设置失败: ' + (e && e.message ? e.message : String(e)));
      }
    },

    async onOpenSettings() {
      this.settingsOpen = true;
      await this.refreshSettings();
    },

    onCloseSettings() {
      this.settingsOpen = false;
    },

    // 用系统输入法输入 API Key
    async onEditApiKey() {
      const text = await openTextEditor(
        defaultTextEditConfig({
          title: '填写 API Key',
          initialText: '',
          multiLinesEditVisible: false,
          maxBytes: 200,
          enterButtonText: '保存',
        })
      ).catch(() => null);
      if (this.destroyed || text == null) return;
      const v = String(text).trim();
      if (!v) return; // 空输入视为取消，不动已有配置
      try {
        await api.saveApiKey(v);
        await this.refreshSettings();
        diag('API Key 已保存（长度 ' + v.length + '）');
      } catch (e) {
        diag('保存 API Key 失败: ' + (e && e.message ? e.message : String(e)));
      }
    },

    // 用系统输入法输入 API 端点
    async onEditApiBase() {
      const text = await openTextEditor(
        defaultTextEditConfig({
          title: '填写 API 请求端点',
          initialText: this.settings.apiBaseUrl || '',
          multiLinesEditVisible: false,
          maxBytes: 300,
          enterButtonText: '保存',
        })
      ).catch(() => null);
      if (this.destroyed || text == null) return;
      const raw = String(text).trim();
      if (!raw) return;
      const normalized = api.normalizeBaseUrl(raw);
      if (!normalized) {
        // 不合法的端点直接丢弃，并给出提示（避免存进无效值导致后续请求全失败）
        this.warn('端点格式无效，需形如 https://api.example.com/v1');
        return;
      }
      try {
        await api.saveApiBaseUrl(normalized);
        await this.refreshSettings();
        diag('API 端点已保存: ' + normalized);
      } catch (e) {
        diag('保存端点失败: ' + (e && e.message ? e.message : String(e)));
      }
    },

    // 清除已保存的配置（Key + 端点）
    async onClearSettings() {
      try {
        await api.saveApiKey('');
        await api.saveApiBaseUrl('');
        await this.refreshSettings();
        diag('已清除配置');
      } catch (e) {
        diag('清除配置失败: ' + (e && e.message ? e.message : String(e)));
      }
    },

    // 顶部临时提示（复用 storageWarning 那条横幅）
    warn(msg) {
      this.storageWarning = msg;
      if (this._warnTimer) clearTimeout(this._warnTimer);
      this._warnTimer = setTimeout(() => {
        this._warnTimer = null;
        if (!this.destroyed) this.storageWarning = '';
      }, 4000);
    },

  },
};
</script>

<style lang="less" scoped>
@import "base.less";

// ============================================================================
//  视觉规范取自有道词典笔官方设计系统（yd-dictpen-haasui）：
//  主色 #f9532f / 深色底 #151626 / 卡片 #222328 / 字体 OPPOSans
//  详见 docs/official-design-tokens.md
// ============================================================================

.chat-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: @background-page;
  font-family: @font-family;
}

// ---------- 顶部栏 ----------
.header {
  width: 100%;
  height: 76rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  padding-left: 20rpx;
  padding-right: 18rpx;
  background-color: @background-page;
  flex-shrink: 0;
}

// 品牌标识：橙色方块 + D（大圆角，呼应官方图标风格）
// 菜单键（汉堡图标）：三条横线用 view 画，避免字体图标缺字
.menu-btn {
  width: 56rpx;
  height: 56rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 18rpx;
  background-color: @background-card;
  flex-shrink: 0;
}

.menu-btn-active {
  background-color: @background-elevated;
}

.menu-line {
  width: 26rpx;
  height: 3rpx;
  border-radius: 2rpx;
  background-color: @text-secondary;
}

.menu-line-mid {
  margin-top: 5rpx;
  margin-bottom: 5rpx;
}

.header-title-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  margin-left: 14rpx;
}

.header-title {
  font-size: 28rpx;
  font-weight: bold;
  color: @text-primary;
  line-height: 34rpx;
}

.header-sub {
  font-size: 18rpx;
  color: @text-muted;
  line-height: 22rpx;
  margin-top: 1rpx;
}

// 清空：描边胶囊（激活态填充），比实心按钮更克制
.header-clear {
  height: 44rpx;
  padding-left: 20rpx;
  padding-right: 20rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  border-width: 1rpx;
  border-style: solid;
  border-color: @border-strong;
  flex-shrink: 0;
}

.header-clear-active {
  background-color: @background-elevated;
}

.header-clear-text {
  font-size: 20rpx;
  color: @text-secondary;
  line-height: 26rpx;
}

// ---------- 存储警告 ----------
.storage-warn {
  width: 100%;
  padding-top: 12rpx;
  padding-bottom: 12rpx;
  padding-left: 24rpx;
  padding-right: 24rpx;
  background-color: @warning-bg;
  flex-shrink: 0;
}

.storage-warn-text {
  font-size: 22rpx;
  color: @warning-text;
  line-height: 30rpx;
}

// ---------- 消息列表 ----------
.msg-list {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding-top: 10rpx;
  padding-bottom: 10rpx;
}

// 空状态
.msg-empty {
  width: 100%;
  margin-top: 40rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.empty-badge {
  width: 88rpx;
  height: 88rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 28rpx;
  background-color: @primary-soft;
  border-width: 2rpx;
  border-style: solid;
  border-color: @primary;
}

.empty-badge-text {
  font-size: 48rpx;
  font-weight: bold;
  color: @primary;
  line-height: 88rpx;
}

.msg-empty-title {
  margin-top: 20rpx;
  font-size: 28rpx;
  font-weight: bold;
  color: @text-primary;
  line-height: 38rpx;
}

.msg-empty-desc {
  width: 460rpx;
  margin-top: 10rpx;
  font-size: 20rpx;
  color: @text-muted;
  line-height: 28rpx;
  text-align: center;
}

.msg-row {
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  padding-left: 20rpx;
  padding-right: 20rpx;
  padding-top: 8rpx;
  padding-bottom: 8rpx;
}

// 用户气泡：右对齐，官方橙
.bubble-user {
  max-width: 550rpx;
  margin-left: auto;
  padding-top: 18rpx;
  padding-bottom: 18rpx;
  padding-left: 26rpx;
  padding-right: 26rpx;
  border-top-left-radius: 26rpx;
  border-top-right-radius: 26rpx;
  border-bottom-left-radius: 26rpx;
  border-bottom-right-radius: 8rpx;
  background-color: @primary;
}

.bubble-user-text {
  font-size: 28rpx;
  color: #ffffff;
  line-height: 42rpx;
  overflow-wrap: break-word;
}

// AI 气泡：左对齐卡片，靠底色区分层次（官方风格不加描边）
.bubble-ai {
  max-width: 590rpx;
  margin-right: auto;
  padding-top: 18rpx;
  padding-bottom: 18rpx;
  padding-left: 26rpx;
  padding-right: 26rpx;
  border-top-left-radius: 8rpx;
  border-top-right-radius: 26rpx;
  border-bottom-left-radius: 26rpx;
  border-bottom-right-radius: 26rpx;
  background-color: @background-card;
}

.bubble-ai-text {
  font-size: 28rpx;
  color: @text-primary;
  line-height: 42rpx;
  overflow-wrap: break-word;
}

// 流式光标
.stream-cursor {
  font-size: 28rpx;
  color: @primary;
  line-height: 42rpx;
  animation-name: cursor-blink;
  animation-duration: 1s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}

@keyframes cursor-blink {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.15;
  }
  100% {
    opacity: 1;
  }
}

// 思考中动画：三个点用固定尺寸的圆点，避免字体度量差异导致挤成一团
.thinking-dots {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  height: 42rpx;
}

.thinking-dot {
  width: 14rpx;
  height: 14rpx;
  border-top-left-radius: 7rpx;
  border-top-right-radius: 7rpx;
  border-bottom-left-radius: 7rpx;
  border-bottom-right-radius: 7rpx;
  background-color: @primary;
  margin-right: 12rpx;
  animation-name: dot-bounce;
  animation-duration: 1.2s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}

.thinking-dot-1 {
  animation-delay: 0s;
}

.thinking-dot-2 {
  animation-delay: 0.2s;
}

.thinking-dot-3 {
  animation-delay: 0.4s;
}

@keyframes dot-bounce {
  0% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.25;
  }
}

// ---------- 底部输入区 ----------
.input-bar {
  width: 100%;
  height: 100rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  padding-left: 18rpx;
  padding-right: 18rpx;
  background-color: @background-page;
  flex-shrink: 0;
}

// 设置按钮（输入框左侧）
.settings-btn {
  width: 68rpx;
  height: 68rpx;
  margin-right: 12rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 34rpx;
  background-color: @background-card;
  flex-shrink: 0;
}

.settings-btn-active {
  background-color: @background-elevated;
}

.settings-icon {
  font-size: 32rpx;
  color: @text-secondary;
  line-height: 40rpx;
}

.input-box {
  flex: 1;
  height: 68rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  padding-left: 26rpx;
  padding-right: 26rpx;
  border-radius: @radius-pill;
  background-color: @background-input;
}

.input-box-active {
  background-color: @background-elevated;
}

.input-placeholder {
  font-size: 26rpx;
  color: @text-faint;
  line-height: 36rpx;
}

.input-text {
  font-size: 26rpx;
  color: @text-primary;
  line-height: 36rpx;
  overflow-wrap: break-word;
}

.send-btn {
  width: 116rpx;
  height: 68rpx;
  margin-left: 12rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  background-color: @primary;
  flex-shrink: 0;
}

.send-btn-active {
  background-color: @primary-deep;
}

.send-btn-text {
  font-size: 24rpx;
  font-weight: bold;
  color: #ffffff;
  line-height: 32rpx;
}

// ---------- 设置页 ----------
// 整页替换（不是覆盖层）——nvue 的 position:fixed 在这台设备上渲染不可靠。
.root {
  width: 100%;
  height: 100%;
}

.settings-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: @background-page;
  padding-top: 12rpx;
  padding-bottom: 12rpx;
}

.settings-header {
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: 24rpx;
  padding-right: 20rpx;
  padding-bottom: 12rpx;
  flex-shrink: 0; // 标题栏不压缩，始终可见（返回入口不会跑丢）
}

.settings-title {
  font-size: 32rpx;
  font-weight: bold;
  color: @text-primary;
  line-height: 44rpx;
}

.settings-done {
  height: 54rpx;
  padding-left: 26rpx;
  padding-right: 26rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  background-color: @primary;
}

.settings-done-active {
  background-color: @primary-deep;
}

.settings-done-text {
  font-size: 24rpx;
  font-weight: bold;
  color: #ffffff;
  line-height: 32rpx;
}

// 抽屉里的「新建」按钮
.new-btn {
  height: 44rpx;
  padding-left: 20rpx;
  padding-right: 20rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  background-color: @primary;
}

.new-btn-active {
  background-color: @primary-deep;
}

.new-btn-text {
  font-size: 20rpx;
  font-weight: bold;
  color: #ffffff;
  line-height: 26rpx;
}

// ---------- 会话抽屉 ----------
// 遮罩：铺满屏（点它关闭）。用 absolute 相对 .root 定位——这台设备上
// position:fixed 渲染不可靠，absolute + .root 撑满同样能覆盖全屏。
.drawer-mask {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.55);
  animation-name: mask-in;
  animation-duration: 0.2s;
  animation-timing-function: ease-out;
}

@keyframes mask-in {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

// 抽屉本体：从左滑出，只占左侧一部分，右侧露出聊天页
.drawer {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 430rpx;
  display: flex;
  flex-direction: column;
  background-color: @background-card;
  border-top-right-radius: 28rpx;
  border-bottom-right-radius: 28rpx;
  padding-top: 14rpx;
  padding-bottom: 14rpx;
  padding-left: 16rpx;
  padding-right: 16rpx;
  animation-name: drawer-in;
  animation-duration: 0.22s;
  animation-timing-function: ease-out;
}

@keyframes drawer-in {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(0);
  }
}

.drawer-header {
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: 6rpx;
  padding-bottom: 12rpx;
  flex-shrink: 0;
}

.drawer-title {
  font-size: 28rpx;
  font-weight: bold;
  color: @text-primary;
  line-height: 36rpx;
}

// 抽屉内容可滚动
.drawer-body {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
}

// ---------- 会话列表 ----------
.sess-row {
  width: 100%;
  min-height: 76rpx;
  margin-bottom: 10rpx;
  padding-top: 12rpx;
  padding-bottom: 12rpx;
  padding-left: 20rpx;
  padding-right: 12rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  border-radius: @radius-medium;
  background-color: @background-card;
}

.sess-row-active {
  background-color: @background-elevated;
}

.sess-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.sess-title {
  font-size: 24rpx;
  color: @text-primary;
  line-height: 32rpx;
  overflow-wrap: break-word;
}

// 当前会话用主色标出
.sess-title-active {
  color: @primary;
  font-weight: bold;
}

.sess-sub {
  margin-top: 2rpx;
  font-size: 18rpx;
  color: @text-faint;
  line-height: 24rpx;
}

.sess-del {
  width: 52rpx;
  height: 52rpx;
  margin-left: 10rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 26rpx;
  background-color: @background-elevated;
  flex-shrink: 0;
}

.sess-del-active {
  background-color: @danger;
}

.sess-del-text {
  font-size: 22rpx;
  color: @text-secondary;
  line-height: 28rpx;
}

.sess-empty {
  width: 100%;
  margin-top: 40rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.sess-empty-text {
  font-size: 22rpx;
  color: @text-faint;
  line-height: 30rpx;
}

// 底部固定操作区（返回按钮不随列表滚走）
.settings-footer {
  width: 100%;
  padding-left: 24rpx;
  padding-right: 24rpx;
  padding-top: 12rpx;
  flex-shrink: 0;
}

// 可滚动内容区：占满剩余高度，溢出滚动（与 .msg-list 同一套可行结构）
.settings-body {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding-left: 24rpx;
  padding-right: 24rpx;
}

// ---------- 命令授权页 ----------
.danger-badge {
  height: 36rpx;
  padding-left: 16rpx;
  padding-right: 16rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  background-color: @danger;
}

.danger-badge-text {
  font-size: 18rpx;
  font-weight: bold;
  color: #ffffff;
  line-height: 24rpx;
}

.confirm-reason {
  font-size: 24rpx;
  color: @text-secondary;
  line-height: 34rpx;
}

// 命令本体：等宽感 + 深色底，便于核对
.cmd-box {
  width: 100%;
  padding-top: 18rpx;
  padding-bottom: 18rpx;
  padding-left: 20rpx;
  padding-right: 20rpx;
  border-radius: @radius-medium;
  background-color: @background-sunken;
  border-width: 1rpx;
  border-style: solid;
  border-color: @border-strong;
}

.cmd-text {
  font-size: 24rpx;
  color: @primary;
  line-height: 34rpx;
  overflow-wrap: break-word;
}

.danger-note {
  width: 100%;
  margin-top: 16rpx;
  padding-top: 14rpx;
  padding-bottom: 14rpx;
  padding-left: 18rpx;
  padding-right: 18rpx;
  border-radius: @radius-medium;
  background-color: @danger-soft;
  border-width: 1rpx;
  border-style: solid;
  border-color: @danger;
  display: flex;
  flex-direction: column;
}

.danger-note-title {
  font-size: 22rpx;
  font-weight: bold;
  color: @danger;
  line-height: 30rpx;
}

.danger-note-item {
  margin-top: 6rpx;
  font-size: 20rpx;
  color: @text-secondary;
  line-height: 28rpx;
}

.confirm-actions {
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  padding-left: 24rpx;
  padding-right: 24rpx;
  padding-top: 12rpx;
  flex-shrink: 0;
}

.deny-btn {
  flex: 1;
  height: 76rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  background-color: @background-elevated;
}

.deny-btn-active {
  background-color: @border-strong;
}

.deny-btn-text {
  font-size: 26rpx;
  color: @text-secondary;
  line-height: 34rpx;
}

.allow-btn {
  flex: 1;
  height: 76rpx;
  margin-left: 16rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  background-color: @primary;
}

.allow-btn-active {
  background-color: @primary-deep;
}

// 危险命令的允许按钮用红色，强化"这是有风险的操作"
.allow-btn-danger {
  background-color: @danger;
}

.allow-btn-text {
  font-size: 26rpx;
  font-weight: bold;
  color: #ffffff;
  line-height: 34rpx;
}

// ---------- 命令类气泡（执行记录）----------
.bubble-ai-command {
  max-width: 590rpx;
  margin-right: auto;
  padding-top: 14rpx;
  padding-bottom: 14rpx;
  padding-left: 20rpx;
  padding-right: 20rpx;
  border-top-left-radius: 8rpx;
  border-top-right-radius: 20rpx;
  border-bottom-left-radius: 20rpx;
  border-bottom-right-radius: 20rpx;
  background-color: @background-sunken;
  border-width: 1rpx;
  border-style: solid;
  border-color: @border-strong;
}

.bubble-ai-command-text {
  font-size: 22rpx;
  color: @text-secondary;
  line-height: 32rpx;
  overflow-wrap: break-word;
  font-family: monospace;
}

// 未配置时的引导说明
.field-note {
  margin-bottom: 16rpx;
  padding-top: 10rpx;
  padding-bottom: 10rpx;
  padding-left: 16rpx;
  padding-right: 16rpx;
  border-radius: @radius-small;
  background-color: @warning-bg;
  font-size: 20rpx;
  color: @warning-text;
  line-height: 28rpx;
}

.field-label {
  font-size: 24rpx;
  color: @text-muted;
  line-height: 32rpx;
  margin-bottom: 12rpx;
}

.field-label-gap {
  margin-top: 26rpx;
}

.field-box {
  width: 100%;
  height: 84rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  padding-left: 26rpx;
  padding-right: 26rpx;
  border-radius: @radius-medium;
  background-color: @background-card;
}

.field-box-active {
  background-color: @background-elevated;
}

.field-value {
  flex: 1;
  font-size: 24rpx;
  color: @text-primary;
  line-height: 34rpx;
  overflow-wrap: break-word;
}

.field-placeholder {
  flex: 1;
  font-size: 24rpx;
  color: @text-faint;
  line-height: 34rpx;
}

.field-hint {
  margin-top: 10rpx;
  font-size: 20rpx;
  color: @text-faint;
  line-height: 28rpx;
}

.reset-btn {
  width: 100%;
  height: 84rpx;
  margin-top: 30rpx;
  margin-bottom: 8rpx; // 底部留白，滚到底时按钮不贴边
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: @radius-pill;
  border-width: 1rpx;
  border-style: solid;
  border-color: @border-strong;
}

.reset-btn-active {
  background-color: @background-elevated;
}

.reset-btn-text {
  font-size: 26rpx;
  color: @text-secondary;
  line-height: 34rpx;
}
</style>
