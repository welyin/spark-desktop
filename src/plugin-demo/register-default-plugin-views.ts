import { registerPluginView } from '../renderer/plugin-view-registry';
import DemoDefaultView from './DemoDefaultView.vue';

let registered = false;

export function registerDefaultPluginViews(): void {
  if (registered) {
    return;
  }

  registerPluginView('plugin:demo', 'default', DemoDefaultView);
  registered = true;
}