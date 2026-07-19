import { getUpdaterService } from '../updater';
import { registerInvokeHandler, requireSystemDomain } from './helpers';

/**
 * 主程序热更新相关 IPC（仅系统域可用）
 */
export function registerUpdaterHandlers(): void {
  registerInvokeHandler('update-status', async (event) => {
    requireSystemDomain(event);
    return await getUpdaterService().getSnapshot();
  });

  registerInvokeHandler('update-check', async (event) => {
    requireSystemDomain(event);
    return await getUpdaterService().checkForUpdates('manual');
  });

  registerInvokeHandler('update-stage-latest', async (event) => {
    requireSystemDomain(event);
    return await getUpdaterService().stageLatestFullUpdate();
  });

  registerInvokeHandler('update-apply-restart', async (event) => {
    requireSystemDomain(event);
    return await getUpdaterService().applyStagedUpdateAndRestart();
  });

  registerInvokeHandler('update-observe-peer-version', async (event, version: string) => {
    requireSystemDomain(event);
    await getUpdaterService().observePeerVersion(version);
    return { success: true };
  });
}
