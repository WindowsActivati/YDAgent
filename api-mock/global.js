// 开发期模拟系统输入法桥（真机走 global.startTextEdit 路径，见 src/services/input.js）。
//
// 模块名约定：文件名 global.js → 虚拟模块 'global'，
// 对应 input.js 里的 `import { Global } from 'global'`。
// 仅在 aiot-vue-cli preview / simulator 模式下参与打包；真机 AMR 不含本文件。
//
// PC 模拟器没有系统输入法，这里用 window.prompt 模拟输入窗：
//   单行 prompt → 确定：回传 editConfirmed:true + text；取消：editConfirmed:false
// 回调时机用 setTimeout 推迟，保证 startTextEdit() 先返回 uuid、调用方先注册会话。

export class Global {
  constructor() {
    this._handlers = [];
  }

  // 事件器：input.js 里 g.textEditFinished.on(cb) / .off(cb)
  // 回调签名 cb(uuid, payloadJsonStr)，payload 结构见 startTextEdit 说明
  get textEditFinished() {
    return {
      on: (cb) => {
        if (typeof cb === 'function' && this._handlers.indexOf(cb) < 0) {
          this._handlers.push(cb);
        }
      },
      off: (cb) => {
        const i = this._handlers.indexOf(cb);
        if (i >= 0) this._handlers.splice(i, 1);
      },
    };
  }

  // 与输入法配置一致的启动入口：入参为 JSON 字符串，返回会话 UUID
  // 配置字段（input.js defaultTextEditConfig）：title/editType/initialText/...
  startTextEdit(configJson) {
    let cfg = {};
    try {
      cfg = JSON.parse(configJson || '{}');
    } catch (e) {
      cfg = {};
    }
    const uuid =
      'mock-' + new Date().getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const title = typeof cfg.title === 'string' && cfg.title ? cfg.title : '输入';
    const initial = typeof cfg.initialText === 'string' ? cfg.initialText : '';

    // prompt 是同步阻塞的；返回值 null 表示用户取消
    let raw = null;
    try {
      raw = window.prompt(title, initial);
    } catch (e) {
      raw = null;
    }
    const confirmed = typeof raw === 'string';

    setTimeout(() => {
      const payload = JSON.stringify({
        editConfirmed: confirmed,
        text: confirmed ? raw : '',
      });
      this._handlers.slice().forEach((h) => {
        try {
          h(uuid, payload);
        } catch (e) {
          // 回调异常不影响其他监听者
        }
      });
    }, 0);

    return uuid;
  }

  // 关闭会话：PC 上无真实会话，幂等忽略即可
  closeTextEdit(uuid) {
    // no-op
  }
}

export default Global;