import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { levelDB, ensureSystemDomainInitialized, parseDomainFromKey, verifyAccess, getEvidenceHeadHash, verifyEvidenceChain, getEvidenceHeight } from './db';
import { initP2PNode, getP2PNode, isP2PInitialized } from './p2p';
import { registerDomain, unregisterDomain, getDomain, isSystemDomain, isValidPluginDomain } from './domain-registry';
import { OrganizationService } from './organization';
import { rootIdentityManager } from './identity';

/**
 * 从 IPC 事件中获取可信的调用者域
 * 未注册的窗口返回 null，调用方应拒绝访问
 */
function getCallerDomain(event: IpcMainInvokeEvent): string | null {
  return getDomain(event.sender.id);
}

/**
 * 校验调用者是否为系统域
 */
function requireSystemDomain(event: IpcMainInvokeEvent): void {
  const caller = getCallerDomain(event);
  if (!isSystemDomain(caller!)) {
    throw new Error('Access denied: system domain required');
  }
}

/**
 * 校验调用者域对目标域的访问权限
 */
function requireAccess(event: IpcMainInvokeEvent, targetDomain: string | null): void {
  const caller = getCallerDomain(event);
  if (!caller) {
    throw new Error('Access denied: unregistered caller domain');
  }
  verifyAccess(caller, targetDomain);
}

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

const organizationService = new OrganizationService(levelDB, {
  getCurrentRootId: async () => {
    const status = await rootIdentityManager.getStatus();
    return status.unlocked ? status.rootId : null;
  }
});

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

  const filePath = path.join(__dirname, '..', 'renderer', 'dist', 'index.html');
  console.log(`[main] loading renderer from file: ${filePath}`);
  await win.loadFile(filePath, { query });
}

function createPluginWindow(pluginDomain: string, pluginView: string): BrowserWindow {
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

function createWindow() {
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

app.whenReady().then(() => {
  createWindow();

  // 查询当前窗口的可信域（只读，供 preload 展示用）
  ipcMain.handle('get-current-domain', (event) => {
    return { domain: getCallerDomain(event) };
  });

  ipcMain.handle('plugin-open-view', (event, pluginDomain: string, pluginView = 'default') => {
    requireSystemDomain(event);

    if (!isValidPluginDomain(pluginDomain)) {
      throw new Error(`Invalid plugin domain: ${pluginDomain}`);
    }

    const view = typeof pluginView === 'string' && pluginView.trim().length > 0 ? pluginView : 'default';
    const pluginWindow = createPluginWindow(pluginDomain, view);
    return { success: true, windowId: pluginWindow.webContents.id };
  });

  ipcMain.handle('root-status', async (event) => {
    requireSystemDomain(event);
    return await rootIdentityManager.getStatus();
  });

  ipcMain.handle('root-init', async (event, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.initialize(password);
    return {
      rootId: result.rootId,
      mnemonic: result.mnemonic
    };
  });

  ipcMain.handle('root-unlock', async (event, password: string) => {
    requireSystemDomain(event);
    return await rootIdentityManager.unlock(password);
  });

  ipcMain.handle('root-lock', (event) => {
    requireSystemDomain(event);
    rootIdentityManager.lock();
    return { success: true };
  });

  ipcMain.handle('root-sign', (event, payload: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.sign(payload);
  });

  ipcMain.handle('root-derive-domain', (event, domain: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.deriveDomainIdentity(domain);
  });

  ipcMain.handle('org-list-mine', async (event) => {
    requireSystemDomain(event);
    return await organizationService.listMine();
  });

  ipcMain.handle('org-create', async (event, input: { name: string; description?: string }) => {
    requireSystemDomain(event);
    return await organizationService.createOrganization(input);
  });

  ipcMain.handle('org-delete', async (event, orgId: string) => {
    requireSystemDomain(event);
    return await organizationService.deleteOrganization(orgId);
  });

  ipcMain.handle('org-add-member', async (event, orgId: string, memberRootId: string) => {
    requireSystemDomain(event);
    return await organizationService.addMember(orgId, memberRootId);
  });

  ipcMain.handle('org-remove-member', async (event, orgId: string, memberRootId: string) => {
    requireSystemDomain(event);
    return await organizationService.removeMember(orgId, memberRootId);
  });

  ipcMain.handle('db-open', async (event) => {
    requireSystemDomain(event);
    await levelDB.open();
    try {
      await ensureSystemDomainInitialized(levelDB);
      console.log('[main] system domain initialized');
    } catch (err) {
      console.error('[main] failed to initialize system domain', err);
    }

    // 数据库打开后初始化 P2P 节点（注入 db 依赖）
    if (!isP2PInitialized()) {
      initP2PNode(levelDB);
      console.log('[main] p2p node initialized with db');
    }

    return { path: levelDB.path, open: levelDB.isOpen };
  });

  ipcMain.handle('db-close', async (event) => {
    requireSystemDomain(event);
    await levelDB.close();
    return { open: levelDB.isOpen };
  });

  ipcMain.handle('db-get', async (event, key: string) => {
    const target = parseDomainFromKey(key);
    requireAccess(event, target);
    return await levelDB.get(key);
  });

  ipcMain.handle('db-put', async (event, key: string, value: string) => {
    const target = parseDomainFromKey(key);
    requireAccess(event, target);
    await levelDB.put(key, value);
    return { success: true };
  });

  ipcMain.handle('db-del', async (event, key: string) => {
    const target = parseDomainFromKey(key);
    requireAccess(event, target);
    await levelDB.del(key);
    return { success: true };
  });

  ipcMain.handle('db-batch', async (event, operations: any[]) => {
    for (const op of operations) {
      const target = parseDomainFromKey(String(op.key));
      requireAccess(event, target);
    }
    await levelDB.batch(operations);
    return { success: true };
  });

  ipcMain.handle('db-path', (event) => {
    // 已注册的域都可以查看路径
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { path: levelDB.path };
  });

  ipcMain.handle('db-status', (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { open: levelDB.isOpen };
  });

  ipcMain.handle('db-query', async (event, prefix: string) => {
    const target = parseDomainFromKey(prefix);
    requireAccess(event, target);
    const items = await levelDB.queryRange({ prefix, start: prefix, end: `${prefix}\xFF` });
    return items;
  });

  ipcMain.handle('evidence-head-hash', async (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { hash: await getEvidenceHeadHash(levelDB) };
  });

  ipcMain.handle('evidence-verify', async (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { valid: await verifyEvidenceChain(levelDB), height: await getEvidenceHeight(levelDB) };
  });

  // P2P IPC handlers
  ipcMain.handle('p2p-start', async (event) => {
    requireSystemDomain(event);
    if (!isP2PInitialized()) {
      throw new Error('P2P node not initialized. Open database first.');
    }
    try {
      await getP2PNode().start();
      return { started: getP2PNode().isStarted() };
    } catch (err) {
      throw err;
    }
  });

  ipcMain.handle('p2p-stop', async (event) => {
    requireSystemDomain(event);
    if (!isP2PInitialized()) {
      return { started: false };
    }
    try {
      await getP2PNode().stop();
      return { started: getP2PNode().isStarted() };
    } catch (err) {
      throw err;
    }
  });

  ipcMain.handle('p2p-broadcast', async (event, topic: string, message: any) => {
    const targetDomain = message?.domain ?? null;
    requireAccess(event, targetDomain);
    if (!isP2PInitialized()) {
      throw new Error('P2P node not initialized. Open database first.');
    }
    await getP2PNode().broadcast(topic, message);
    return { success: true };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
