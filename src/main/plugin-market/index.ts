import { PluginMarketService } from './service';

let pluginMarketService: PluginMarketService | null = null;

export async function initPluginMarketService(): Promise<void> {
  if (pluginMarketService) {
    return;
  }

  pluginMarketService = new PluginMarketService();
  await pluginMarketService.initialize();
}

export function getPluginMarketService(): PluginMarketService {
  if (!pluginMarketService) {
    throw new Error('Plugin market service not initialized');
  }
  return pluginMarketService;
}
