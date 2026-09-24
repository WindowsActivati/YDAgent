import { BasePage } from './base-page.js';
import { resolveViewportWidth } from './services/device-config.js';

class App extends $falcon.App {
  constructor() {
    super();
  }

  onLaunch(options) {
    super.onLaunch(options);
    // 从 /etc/miniapp/resources/cfg.json 自动适配（native → env → 兜底）
    const width = resolveViewportWidth();
    this.setViewPort(width);
    $falcon.useDefaultBasePageClass(BasePage);
  }

  onShow() {
    super.onShow();
  }

  onHide() {
    super.onHide();
  }

  onDestroy() {
    super.onDestroy();
  }
}

export default App;