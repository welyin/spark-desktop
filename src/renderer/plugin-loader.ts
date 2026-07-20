/**
 * 插件视图自动加载器。
 *
 * 通过 Vite 的 import.meta.glob 扫描 src/plugins 下的插件入口，
 * 让每个插件在自身入口模块中调用 registerPluginView 完成注册。
 * 内核（App.vue / main.ts）无需感知具体插件。
 */
const pluginEntries = import.meta.glob('../plugins/*/index.ts', { eager: true });

export function initializePlugins(): void {
  // 插件入口模块在被 import 时已自行完成注册。
  // 这里仅保留一个显式的初始化入口，便于后续加入校验/日志。
  void pluginEntries;
}
