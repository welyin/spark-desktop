import { app, BrowserWindow } from 'electron';
import path from 'path';
import { registerDomain, unregisterDomain } from './domain-registry';

function resolveDevServerUrl(): string | null {
  const direct = process.env.VITE_DEV_SERVER_URL || process.env.FORGE_DEV_SERVER_URL || null;
  if (direct) {
    return direct;
  }

  const forgeScoped = Object.entries(process.env).find(([key, value]) => {
    return key.endsWith('_VITE_DEV_SERVER_URL') && typeof value === 'string' && value.length > 0;
  });

  if (forgeScoped?.[1]) {
    console.log(`[main] using renderer dev server url from ${forgeScoped[0]}`);
    return forgeScoped[1];
  }

  if (!app.isPackaged) {
    // Fallback for local development when Forge env vars are not injected as expected.
    return 'http://localhost:5199';
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryLoadDevUrl(win: BrowserWindow, url: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await win.loadURL(url);
      return true;
    } catch (error) {
      if (attempt === 20) {
        console.warn('[main] failed to load dev url after retries', error);
        return false;
      }
      await sleep(300);
    }
  }
  return false;
}

async function loadRendererWindow(win: BrowserWindow, query: Record<string, string>): Promise<void> {
  const devUrl = resolveDevServerUrl();
  if (devUrl) {
    const url = new URL(devUrl as string);
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    const finalUrl = url.toString();
    console.log(`[main] loading renderer from dev url: ${finalUrl}`);
    const loaded = await tryLoadDevUrl(win, finalUrl);
    if (loaded) {
      return;
    }
    console.warn('[main] fallback to dist renderer bundle');
  }

  const filePath = path.join(__dirname, '..', 'renderer', 'main_window', 'index.html');
  console.log(`[main] loading renderer from file: ${filePath}`);
  await win.loadFile(filePath, { query });
}

export function createPluginWindow(pluginDomain: string, pluginView: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: `Plugin View - ${pluginDomain}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  registerDomain(win.webContents.id, pluginDomain);
  win.webContents.on('destroyed', () => {
    unregisterDomain(win.webContents.id);
  });

  void loadRendererWindow(win, {
    pluginDomain,
    pluginView
  });

  return win;
}

export function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // 主窗口绑定 system 域（全权限）
  registerDomain(win.webContents.id, 'system');

  // 窗口关闭时清理域注册
  win.webContents.on('destroyed', () => {
    unregisterDomain(win.webContents.id);
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  void loadRendererWindow(win, {});

  win.webContents.openDevTools({ mode: 'right' });
}
