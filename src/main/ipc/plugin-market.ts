import { getPluginMarketService, initPluginMarketService } from '../plugin-market';
import { registerInvokeHandler, requireSystemDomain } from './helpers';

/**
 * 插件市场相关 IPC（仅系统域可用）
 * initPluginMarketService 幂等，handler 内重复调用无副作用
 */
export function registerPluginMarketHandlers(): void {
  registerInvokeHandler('plugin-market-list', async (event) => {
    requireSystemDomain(event);
    await initPluginMarketService();
    return getPluginMarketService().listMarket();
  });

  registerInvokeHandler('plugin-market-check-updates', async (event, pluginId?: string) => {
    requireSystemDomain(event);
    await initPluginMarketService();
    return await getPluginMarketService().checkForUpdates(pluginId);
  });

  registerInvokeHandler('plugin-market-install', async (event, pluginId: string) => {
    requireSystemDomain(event);
    await initPluginMarketService();
    return await getPluginMarketService().install(pluginId);
  });

  registerInvokeHandler('plugin-market-upgrade', async (event, pluginId: string) => {
    requireSystemDomain(event);
    await initPluginMarketService();
    return await getPluginMarketService().upgrade(pluginId);
  });

  registerInvokeHandler('plugin-market-set-enabled', async (event, pluginId: string, enabled: boolean) => {
    requireSystemDomain(event);
    await initPluginMarketService();
    return await getPluginMarketService().setEnabled(pluginId, enabled);
  });
}
