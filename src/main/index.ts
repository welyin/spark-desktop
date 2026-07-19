import { app, BrowserWindow } from 'electron';
import { initPluginMarketService } from './plugin-market';
import { initUpdaterService, getUpdaterService } from './updater';
import { ensureCoreServicesStarted } from './bootstrap';
import { registerAllIpcHandlers } from './ipc';
import { createWindow } from './windows';

app.whenReady().then(() => {
  initUpdaterService();
  void initPluginMarketService();

  registerAllIpcHandlers();
  createWindow();

  // 后台启动核心服务，避免阻塞 IPC 注册。
  void (async () => {
    try {
      await getUpdaterService().processPendingInstall();
    } catch (error) {
      console.warn('[main] failed to process pending installer', error);
    }

    try {
      await ensureCoreServicesStarted();
    } catch (error) {
      console.error('[main] failed to start core services automatically', error);
    }

    try {
      await getUpdaterService().checkForUpdates('startup');
    } catch (error) {
      console.warn('[main] startup update check skipped', error);
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
