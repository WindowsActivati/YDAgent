import { BasePage } from '../../base-page.js';
import ChatComponent from './index.vue';

class PageIndex extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(ChatComponent);
  }
}

export default PageIndex;
