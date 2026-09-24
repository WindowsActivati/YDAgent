// 开发期模拟 native libjsapi_deepseek.so 的 DeepSeek 模块。
//
// 模块名约定：文件名 deepseek.js → 虚拟模块 'deepseek'，
// 对应 src/services/deepseek-api.js 的 `import { DeepSeek } from 'deepseek'`。
// 仅在 aiot-vue-cli preview / simulator 模式下参与打包；真机 AMR 不含本文件。
//
// 与 native 的返回约定完全一致（见 native/src/DeepSeekModule/JSDeepSeek.cpp）：
//   chat() → Promise<JSON 字符串>
//     {"ok":true,"content":"..."}                            成功
//     {"ok":false,"error":{"code":"...","message":"...","status":N}}  失败
//   code === 'unavailable' 表示网络不可用 → JS 侧自动走 net.request 兜底。
// PC 上没有 fetch 之外的网络桥，这里直接用浏览器 fetch 请求 DeepSeek API。

const MOCK_VERSION = '1.0.0-mock';

function buildOk(content) {
  return JSON.stringify({ ok: true, content });
}

function buildErr(code, message, status) {
  const error = { code, message: String(message || '') };
  if (status) error.status = status;
  return JSON.stringify({ ok: false, error });
}

function withTimeout(ms, promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms || 60000);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export const DeepSeek = {
  version() {
    return MOCK_VERSION;
  },

  // 同步：PC 上没有 /etc/miniapp/resources/cfg.json，返回空串，
  // device-config.js 会自动落到 $falcon.env / 内置兜底值。
  getDeviceConfig() {
    return '';
  },

  // 入参 requestJson 与 native 相同（chat 请求体 + api_base_url/api_key/timeout_ms）
  chat(requestJson) {
    let req = {};
    try {
      req = JSON.parse(requestJson);
    } catch (e) {
      return Promise.resolve(buildErr('invalid_request', '请求 JSON 解析失败'));
    }

    // 端点和 Key 都由调用方传入（app 不再内置默认值）
    const base = String(req.api_base_url || '').replace(/\/+$/, '');
    const key = String(req.api_key || '');
    if (!key || !base) {
      return Promise.resolve(buildErr('not_configured', '请先在设置里填写 API Key 和请求端点'));
    }

    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      max_tokens: req.max_tokens,
      // 工具定义透传（与 native 一致），便于在模拟器里调试工具调用流程
      ...(Array.isArray(req.tools) && req.tools.length
        ? { tools: req.tools, ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}) }
        : {}),
      stream: false,
    });

    const requestPromise = fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body,
    })
      .then(async (resp) => {
        let data = null;
        try {
          data = await resp.json();
        } catch (e) {
          data = null;
        }
        if (
          resp.ok &&
          data &&
          Array.isArray(data.choices) &&
          data.choices.length
        ) {
          const first = data.choices[0];
          const msg = (first && first.message) || null;

          // 工具调用：与 native 一致，返回 {ok:true, tool_calls, content}
          // （此时 content 通常为空，不能当作错误）
          if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            return JSON.stringify({
              ok: true,
              tool_calls: msg.tool_calls,
              content: typeof msg.content === 'string' ? msg.content : '',
            });
          }

          let content = null;
          if (msg && typeof msg.content === 'string') content = msg.content;
          else if (first && typeof first.text === 'string') content = first.text;

          if (content != null && content !== '') return buildOk(content);
          if (content === '') {
            const fr = first && first.finish_reason;
            return buildErr(
              'bad_response',
              fr === 'length' ? '回复被长度限制截断（未产生内容）' : '模型返回了空回复，请重试',
              resp.status
            );
          }
          return buildErr('bad_response', '响应格式不符合预期（缺少 choices[0].message）', resp.status);
        }
        const msg =
          (data && data.error && (data.error.message || data.error.type)) ||
          'HTTP ' + resp.status;
        const code = resp.status === 401 ? 'authentication_error' : 'api_error';
        return buildErr(code, msg, resp.status);
      })
      .catch((err) => {
        // 与 native 一致：网络不可用 → unavailable，触发 JS 侧 fallback
        return buildErr('unavailable', String((err && err.message) || err), 0);
      });

    return withTimeout(req.timeout_ms, requestPromise).catch(() =>
      buildErr('timeout', '请求超时', 0)
    );
  },
};

// 命令执行 mock：PC 上**故意不执行**任何命令，只把内容打出来。
// 理由：模拟器跑在开发机上，真执行 shell 会在你的电脑上跑 AI 生成的命令，
// 风险与收益完全不对等。真机由 native execCommand 实现。
DeepSeek.execCommand = function (cmd, timeoutMs) {
  const msg = '[mock-execCommand] 模拟器不执行命令，仅回显: ' + cmd;
  try {
    if (typeof console !== 'undefined' && console.log) console.log(msg);
  } catch (e) {
    /* 忽略 */
  }
  return Promise.resolve(
    JSON.stringify({
      code: 0,
      output: msg + '\n（真机才会实际执行）',
      timedOut: false,
      truncated: false,
    })
  );
};

// 文件读写 mock：用内存 Map 模拟，不触碰开发机文件系统
const MOCK_FILES = new Map();

DeepSeek.readFile = function (path, maxBytes) {
  const key = String(path);
  if (!MOCK_FILES.has(key)) {
    return Promise.resolve(JSON.stringify({ ok: false, error: '文件不存在（模拟器）' }));
  }
  const content = MOCK_FILES.get(key);
  return Promise.resolve(
    JSON.stringify({ ok: true, content, size: content.length, truncated: false })
  );
};

DeepSeek.writeFile = function (path, content) {
  const key = String(path);
  const created = !MOCK_FILES.has(key);
  const old = MOCK_FILES.get(key) || '';
  MOCK_FILES.set(key, String(content));
  try {
    if (typeof console !== 'undefined' && console.log) {
      console.log('[mock-writeFile] ' + key + ' (' + String(content).length + ' 字节，' +
                  (created ? '新建' : '覆盖') + ')');
    }
  } catch (e) {
    /* 忽略 */
  }
  // 简化 diff：只报行数变化（模拟器不需要真实 diff）
  const diff = created
    ? '(新建文件，共 ' + String(content).split('\n').length + ' 行)'
    : '(覆盖：原 ' + old.length + ' 字节 → 现 ' + String(content).length + ' 字节)';
  return Promise.resolve(
    JSON.stringify({ ok: true, bytes: String(content).length, created, diff })
  );
};

// 诊断日志（真机写 /tmp/deepseek_diag.log；PC 上打到 console）
DeepSeek.debugLog = function (text) {
  try {
    if (typeof console !== 'undefined' && console.log) console.log('[mock-debugLog] ' + text);
  } catch (e) {
    /* 忽略 */
  }
  return JSON.stringify({ ok: true });
};

// 流式 mock：真机走 SSE + publish('delta')；PC 上用 setTimeout 逐段模拟，
// 这样在模拟器里也能看到逐字效果与工具调用流程。
// 注意：必须真实实现（而非省略），否则 chatRaw 会一直走非流式分支，
// 导致「流式 + 工具调用」这条路径在 PC 上永远测不到。
const mockListeners = {}; // topic -> [cb]

DeepSeek.on = function (topic, cb) {
  if (typeof cb !== 'function') return 0;
  if (!mockListeners[topic]) mockListeners[topic] = [];
  mockListeners[topic].push(cb);
  return mockListeners[topic].length; // 返回 token
};

function mockPublish(topic, payload) {
  const list = mockListeners[topic] || [];
  for (let i = 0; i < list.length; i++) {
    try {
      list[i](payload);
    } catch (e) {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

// 把整段文字按小块推送，模拟流式
function mockEmitDelta(text, done) {
  const step = 3; // 每次 3 个字符，足够看出逐字效果
  let i = 0;
  const timer = setInterval(() => {
    if (i >= text.length) {
      clearInterval(timer);
      done();
      return;
    }
    mockPublish('delta', { text: text.slice(i, i + step) });
    i += step;
  }, 30);
}

DeepSeek.chatStream = function (requestJson) {
  return DeepSeek.chat(requestJson).then((raw) => {
    let res;
    try {
      res = JSON.parse(raw);
    } catch (e) {
      return raw; // 原样返回（解析失败时上层会报错）
    }
    // 把结果改写成"流式形态"：逐段推送 content，最后返回完整 JSON
    const content = (res && res.ok && typeof res.content === 'string') ? res.content : '';
    if (!content) return raw; // 工具调用 / 错误：无需推送增量
    return new Promise((resolve) => {
      mockEmitDelta(content, () => resolve(raw));
    });
  });
};

// 本地持久化 mock（真机走 native 文件 IO，PC 上用 localStorage）
const MOCK_STORE_KEY = 'deepseek_mock_store';

DeepSeek.storePath = function () {
  return '(mock: localStorage/' + MOCK_STORE_KEY + ')';
};

DeepSeek.loadStore = function () {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(MOCK_STORE_KEY)) || '';
  } catch (e) {
    return '';
  }
};

DeepSeek.saveStore = function (content) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MOCK_STORE_KEY, String(content));
      return JSON.stringify({ ok: true });
    }
  } catch (e) {
    /* 落到下面的失败返回 */
  }
  return JSON.stringify({ ok: false, error: 'no localStorage' });
};

export default DeepSeek;