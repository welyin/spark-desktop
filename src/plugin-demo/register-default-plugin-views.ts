import { registerPluginView } from '../renderer/plugin-view-registry';
import DemoDefaultView from './DemoDefaultView.vue';
import WeiboCoreView from '../plugins/weibo-core/WeiboCoreView.vue';

let registered = false;

export function registerDefaultPluginViews(): void {
  if (registered) {
    return;
  }

  registerPluginView('plugin:demo', 'default', DemoDefaultView);
  registerPluginView('plugin:weibo-core', 'default', WeiboCoreView);
  registered = true;
}