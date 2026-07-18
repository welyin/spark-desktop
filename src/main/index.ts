import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { levelDB, ensureSystemDomainInitialized, parseDomainFromKey, verifyAccess, getEvidenceHeadHash, verifyEvidenceChain, getEvidenceHeight } from './db';
import { getPluginCollection } from './db/plugin';
import { initP2PNode, getP2PNode, isP2PInitialized } from './p2p/index';
import { registerDomain, unregisterDomain, getDomain, isSystemDomain, isValidPluginDomain } from './domain-registry';
import { OrganizationService } from './organization/index';
import { rootIdentityManager } from './identity';
import { initUpdaterService, getUpdaterService } from './updater';
import { isKnownPluginDomain, listPluginCatalog } from './plugins/catalog';
import { getPluginMarketService, initPluginMarketService } from './plugin-market';

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

function requirePluginDomain(event: IpcMainInvokeEvent): string {
  const caller = getCallerDomain(event);
  if (!caller || !isValidPluginDomain(caller)) {
    throw new Error('Access denied: plugin domain required');
  }
  return caller;
}

function resolvePluginDomainAccess(event: IpcMainInvokeEvent, requestedDomain?: string): string {
  const caller = getCallerDomain(event);

  if (caller && isValidPluginDomain(caller)) {
    if (requestedDomain && requestedDomain !== caller) {
      throw new Error('Access denied: plugin domain mismatch');
    }
    return caller;
  }

  if (isSystemDomain(caller ?? undefined)) {
    if (!requestedDomain || !isValidPluginDomain(requestedDomain)) {
      throw new Error('Access denied: valid plugin domain is required for system caller');
    }
    return requestedDomain;
  }

  throw new Error('Access denied: plugin domain required');
}

function registerInvokeHandler(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
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
}, {
  syncOrganizationToMember: async ({ organization, member, targetRootId }) => {
    if (!isP2PInitialized()) {
      throw new Error('P2P node is not initialized. Open database first.');
    }

    if (!getP2PNode().isStarted()) {
      throw new Error('P2P node is not started. Start P2P before adding organization members.');
    }

    if (!member.nodeInfo) {
      throw new Error('Member node info is required for p2p sync');
    }

    await getP2PNode().syncOrganizationToMember(member.nodeInfo, targetRootId, organization);
  }
});

let coreServicesLastError: string | null = null;

async function ensurePluginMarketStarted(): Promise<void> {
  await initPluginMarketService();
}

async function ensureCoreServicesStarted(): Promise<void> {
  try {
    await levelDB.open();

    try {
      await ensureSystemDomainInitialized(levelDB);
      console.log('[main] system domain initialized');
    } catch (err) {
      console.error('[main] failed to initialize system domain', err);
    }

    if (!isP2PInitialized()) {
      initP2PNode(levelDB, {
        getCurrentRootId: async () => {
          const status = await rootIdentityManager.getStatus();
          // P2P org-share matching should work even if identity is currently locked.
          return status.rootId;
        }
      }, {
        appVersion: app.getVersion(),
        onPeerVersionObserved: async (version, peerId) => {
          console.log('[main] observed peer app version', { peerId, version });
          await getUpdaterService().observePeerVersion(version, peerId);
        }
      });
      console.log('[main] p2p node initialized with db');
    }

    if (!getP2PNode().isStarted()) {
      await getP2PNode().start();
      console.log('[main] p2p node started automatically');
    }

    coreServicesLastError = null;
  } catch (error) {
    coreServicesLastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
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
  initUpdaterService();
  void ensurePluginMarketStarted();

  // 关键身份 IPC 先行注册，避免启动阶段异步任务导致首屏请求无 handler。
  registerInvokeHandler('root-status', async (event) => {
    requireSystemDomain(event);
    return await rootIdentityManager.getStatus();
  });

  registerInvokeHandler('root-init', async (event, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.initialize(password);
    return {
      rootId: result.rootId,
      mnemonic: result.mnemonic
    };
  });

  registerInvokeHandler('root-unlock', async (event, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.unlock(password);

    void getUpdaterService().checkForUpdates('startup').catch((error) => {
      console.warn('[main] post-login update check failed', error);
    });

    // 登录成功后立即返回给 UI，后台异步执行节点重连与数据对账。
    void (async () => {
      try {
        await ensureCoreServicesStarted();
        if (isP2PInitialized() && getP2PNode().isStarted()) {
          await getP2PNode().bootstrapOrganizationNetworkOnLogin();
        }
      } catch (error) {
        console.warn('[main] failed to bootstrap organization peers after login', error);
      }
    })();

    return result;
  });

  registerInvokeHandler('root-lock', (event) => {
    requireSystemDomain(event);
    rootIdentityManager.lock();
    return { success: true };
  });

  registerInvokeHandler('root-sign', (event, payload: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.sign(payload);
  });

  registerInvokeHandler('root-derive-domain', (event, domain: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.deriveDomainIdentity(domain);
  });

  // 查询当前窗口的可信域（只读，供 preload 展示用）
  registerInvokeHandler('get-current-domain', (event) => {
    return { domain: getCallerDomain(event) };
  });

  registerInvokeHandler('plugin-open-view', (event, pluginDomain: string, pluginView = 'default') => {
    requireSystemDomain(event);

    if (!isValidPluginDomain(pluginDomain)) {
      throw new Error(`Invalid plugin domain: ${pluginDomain}`);
    }

    const view = typeof pluginView === 'string' && pluginView.trim().length > 0 ? pluginView : 'default';
    const pluginWindow = createPluginWindow(pluginDomain, view);
    return { success: true, windowId: pluginWindow.webContents.id };
  });

  registerInvokeHandler('org-list-mine', async (event) => {
    requireSystemDomain(event);
    return await organizationService.listMine();
  });

  registerInvokeHandler('org-create', async (event, input: { name: string; description?: string; basePluginDomain: string }) => {
    requireSystemDomain(event);
    if (!input?.basePluginDomain || !isKnownPluginDomain(input.basePluginDomain)) {
      throw new Error('Organization must choose a valid base plugin');
    }
    return await organizationService.createOrganization(input);
  });

  registerInvokeHandler('plugin-list-catalog', (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return listPluginCatalog();
  });

  registerInvokeHandler('plugin-market-list', async (event) => {
    requireSystemDomain(event);
    await ensurePluginMarketStarted();
    return getPluginMarketService().listMarket();
  });

  registerInvokeHandler('plugin-market-check-updates', async (event, pluginId?: string) => {
    requireSystemDomain(event);
    await ensurePluginMarketStarted();
    return await getPluginMarketService().checkForUpdates(pluginId);
  });

  registerInvokeHandler('plugin-market-install', async (event, pluginId: string) => {
    requireSystemDomain(event);
    await ensurePluginMarketStarted();
    return await getPluginMarketService().install(pluginId);
  });

  registerInvokeHandler('plugin-market-upgrade', async (event, pluginId: string) => {
    requireSystemDomain(event);
    await ensurePluginMarketStarted();
    return await getPluginMarketService().upgrade(pluginId);
  });

  registerInvokeHandler('plugin-market-set-enabled', async (event, pluginId: string, enabled: boolean) => {
    requireSystemDomain(event);
    await ensurePluginMarketStarted();
    return await getPluginMarketService().setEnabled(pluginId, enabled);
  });

  registerInvokeHandler('plugin-current-root', async (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    const status = await rootIdentityManager.getStatus();
    return {
      unlocked: status.unlocked,
      rootId: status.unlocked ? status.rootId : null
    };
  });

  registerInvokeHandler('plugin-org-list-mine', async (event, pluginDomain?: string) => {
    resolvePluginDomainAccess(event, pluginDomain);
    return await organizationService.listMine();
  });

  registerInvokeHandler('plugin-doc-get', async (event, collection: string, id: string, pluginDomain?: string) => {
    const domain = resolvePluginDomainAccess(event, pluginDomain);
    const coll = getPluginCollection(levelDB, domain, collection);
    return await coll.get(id);
  });

  registerInvokeHandler('plugin-doc-put', async (event, collection: string, id: string, doc: Record<string, unknown>, pluginDomain?: string) => {
    const domain = resolvePluginDomainAccess(event, pluginDomain);
    const coll = getPluginCollection(levelDB, domain, collection);
    await coll.put(id, doc);
    return { success: true };
  });

  registerInvokeHandler('plugin-doc-delete', async (event, collection: string, id: string, pluginDomain?: string) => {
    const domain = resolvePluginDomainAccess(event, pluginDomain);
    const coll = getPluginCollection(levelDB, domain, collection);
    await coll.delete(id);
    return { success: true };
  });

  registerInvokeHandler('plugin-doc-query', async (event, collection: string, options: { limit?: number; reverse?: boolean; filter?: Array<{ field: string; value: string | number | boolean; op?: 'eq' | 'startsWith' | 'gt' | 'lt' | 'gte' | 'lte' }> } = {}, pluginDomain?: string) => {
    const domain = resolvePluginDomainAccess(event, pluginDomain);
    const coll = getPluginCollection(levelDB, domain, collection);
    return await coll.query(options);
  });

  registerInvokeHandler('org-delete', async (event, orgId: string) => {
    requireSystemDomain(event);
    return await organizationService.deleteOrganization(orgId);
  });

  registerInvokeHandler('org-add-member', async (event, orgId: string, input: { rootId: string; nodeInfo: { peerId?: string; addresses: string[] } }) => {
    requireSystemDomain(event);
    return await organizationService.addMember(orgId, input);
  });

  registerInvokeHandler('org-remove-member', async (event, orgId: string, memberRootId: string) => {
    requireSystemDomain(event);
    return await organizationService.removeMember(orgId, memberRootId);
  });

  registerInvokeHandler('db-open', async (event) => {
    requireSystemDomain(event);
    await ensureCoreServicesStarted();

    return { path: levelDB.path, open: levelDB.isOpen };
  });

  registerInvokeHandler('db-close', async (event) => {
    requireSystemDomain(event);
    if (isP2PInitialized() && getP2PNode().isStarted()) {
      await getP2PNode().stop();
    }
    await levelDB.close();
    return { open: levelDB.isOpen };
  });

  registerInvokeHandler('db-get', async (event, key: string) => {
    const target = parseDomainFromKey(key);
    requireAccess(event, target);
    return await levelDB.get(key);
  });

  registerInvokeHandler('db-put', async (event, key: string, value: string) => {
    const target = parseDomainFromKey(key);
    requireAccess(event, target);
    await levelDB.put(key, value);
    return { success: true };
  });

  registerInvokeHandler('db-del', async (event, key: string) => {
    const target = parseDomainFromKey(key);
    requireAccess(event, target);
    await levelDB.del(key);
    return { success: true };
  });

  registerInvokeHandler('db-batch', async (event, operations: any[]) => {
    for (const op of operations) {
      const target = parseDomainFromKey(String(op.key));
      requireAccess(event, target);
    }
    await levelDB.batch(operations);
    return { success: true };
  });

  registerInvokeHandler('db-path', (event) => {
    // 已注册的域都可以查看路径
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { path: levelDB.path };
  });

  registerInvokeHandler('db-status', (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { open: levelDB.isOpen };
  });

  registerInvokeHandler('db-query', async (event, prefix: string) => {
    const target = parseDomainFromKey(prefix);
    requireAccess(event, target);
    const items = await levelDB.queryRange({ prefix, start: prefix, end: `${prefix}\xFF` });
    return items;
  });

  registerInvokeHandler('evidence-head-hash', async (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { hash: await getEvidenceHeadHash(levelDB) };
  });

  registerInvokeHandler('evidence-verify', async (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return { valid: await verifyEvidenceChain(levelDB), height: await getEvidenceHeight(levelDB) };
  });

  // P2P IPC handlers
  registerInvokeHandler('p2p-start', async (event) => {
    requireSystemDomain(event);
    if (!isP2PInitialized() || !levelDB.isOpen) {
      await ensureCoreServicesStarted();
    }
    try {
      await getP2PNode().start();
      return { started: getP2PNode().isStarted() };
    } catch (err) {
      throw err;
    }
  });

  registerInvokeHandler('p2p-stop', async (event) => {
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

  registerInvokeHandler('p2p-broadcast', async (event, topic: string, message: any) => {
    const targetDomain = message?.domain ?? null;
    requireAccess(event, targetDomain);
    if (!isP2PInitialized()) {
      throw new Error('P2P node not initialized. Open database first.');
    }
    await getP2PNode().broadcast(topic, message);
    return { success: true };
  });

  registerInvokeHandler('p2p-info', async (event) => {
    requireSystemDomain(event);

    if (!isP2PInitialized() || !getP2PNode().isStarted()) {
      try {
        await ensureCoreServicesStarted();
      } catch (error) {
        console.error('[main] p2p-info lazy start failed', error);
      }
    }

    if (!isP2PInitialized()) {
      return {
        initialized: false,
        started: false,
        peerId: null,
        addresses: [],
        error: coreServicesLastError
      };
    }

    const info = getP2PNode().getLocalNodeInfo();
    return {
      ...info,
      error: coreServicesLastError
    };
  });

  registerInvokeHandler('p2p-sync-peer-organizations', async (event, targetPeer: { peerId?: string; addresses: string[] }) => {
    requireSystemDomain(event);

    if (!isP2PInitialized() || !getP2PNode().isStarted()) {
      throw new Error('P2P node is not started. Start P2P before syncing organizations.');
    }

    const status = await rootIdentityManager.getStatus();
    if (!status.unlocked || !status.rootId) {
      throw new Error('Root identity is locked');
    }

    if (!targetPeer || !Array.isArray(targetPeer.addresses) || targetPeer.addresses.length === 0) {
      throw new Error('Target peer addresses are required');
    }

    const pullResult = await getP2PNode().pullOrganizationsFromPeer(targetPeer);

    return {
      attempted: pullResult.pushAttempted,
      synced: pullResult.pushed,
      pullChecked: pullResult.checked,
      pullSynced: pullResult.pulled,
      removed: pullResult.removed,
      skipped: pullResult.skipped
    };
  });

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
