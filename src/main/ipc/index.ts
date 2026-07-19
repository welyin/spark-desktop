import { registerIdentityHandlers } from './identity';
import { registerOrganizationHandlers } from './organization';
import { registerPluginHandlers } from './plugin';
import { registerPluginMarketHandlers } from './plugin-market';
import { registerDbHandlers } from './db';
import { registerP2PHandlers } from './p2p';
import { registerUpdaterHandlers } from './updater';

/**
 * 注册全部 IPC handler
 * 身份相关先行注册，避免启动阶段异步任务导致首屏请求无 handler
 */
export function registerAllIpcHandlers(): void {
  registerIdentityHandlers();
  registerOrganizationHandlers();
  registerPluginHandlers();
  registerPluginMarketHandlers();
  registerDbHandlers();
  registerP2PHandlers();
  registerUpdaterHandlers();
}
