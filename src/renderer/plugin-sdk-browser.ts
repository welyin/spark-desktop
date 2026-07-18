import type { ElectronAPI } from '../main/preload';
import type { PluginSDK } from '../main/plugin-sdk';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

let cachedSDK: PluginSDK | null = null;

function resolveElectronAPI(): ElectronAPI | null {
  if (window.electronAPI) {
    return window.electronAPI;
  }

  try {
    const parentApi = (window.parent as Window & { electronAPI?: ElectronAPI } | null)?.electronAPI;
    if (parentApi) {
      return parentApi;
    }
  } catch {
    // Ignore cross-frame access errors and fall through.
  }

  return null;
}

function resolveRequestedPluginDomain(): string | null {
  const search = new URLSearchParams(window.location.search);
  const fromQuery = search.get('pluginDomain')?.trim() ?? '';
  if (!fromQuery) {
    return null;
  }
  if (!fromQuery.startsWith('plugin:') || fromQuery.length <= 'plugin:'.length) {
    return null;
  }
  return fromQuery;
}

/**
 * 初始化插件 SDK
 *
 * 安全说明：域身份由主进程在创建插件窗口时绑定，
 * 渲染端无法指定或修改域。此函数仅验证当前窗口是否已注册为合法插件域。
 *
 * @throws 如果 electronAPI 不可用，或当前窗口不是插件域
 */
export async function initializePluginSDK(): Promise<PluginSDK> {
  const electronAPI = resolveElectronAPI();
  if (!electronAPI) {
    throw new Error('electronAPI is not available in the renderer context');
  }

  const result = await electronAPI.getDomain();
  const currentDomain = result?.domain;
  const requestedDomain = resolveRequestedPluginDomain();
  const domain =
    currentDomain && currentDomain.startsWith('plugin:') && currentDomain.length > 'plugin:'.length
      ? currentDomain
      : requestedDomain;

  if (!domain || !domain.startsWith('plugin:')) {
    throw new Error(
      `Plugin SDK initialization failed: current window domain is "${currentDomain}". ` +
      'Plugin windows must be created with a plugin: domain by the main process.'
    );
  }

  const needsExplicitPluginDomain = !(currentDomain && currentDomain === domain);

  cachedSDK = {
    domain,
    db: electronAPI.db,
    evidence: electronAPI.evidence,
    p2p: electronAPI.p2p,
    runtime: {
      currentRoot: () => electronAPI.plugin.currentRoot(),
      listMineOrganizations: () =>
        electronAPI.plugin.listMineOrganizations(needsExplicitPluginDomain ? domain : undefined)
    },
    docs: {
      get: (collection: string, id: string) =>
        electronAPI.plugin.docGet(collection, id, needsExplicitPluginDomain ? domain : undefined),
      put: (collection: string, id: string, doc: Record<string, unknown>) =>
        electronAPI.plugin.docPut(collection, id, doc, needsExplicitPluginDomain ? domain : undefined),
      delete: (collection: string, id: string) =>
        electronAPI.plugin.docDelete(collection, id, needsExplicitPluginDomain ? domain : undefined),
      query: (collection: string, options = {}) =>
        electronAPI.plugin.docQuery(collection, options, needsExplicitPluginDomain ? domain : undefined)
    }
  };

  return cachedSDK;
}

/**
 * 获取已初始化的插件 SDK 实例
 *
 * @throws 如果尚未调用 initializePluginSDK
 */
export function getPluginSDK(): PluginSDK {
  if (!cachedSDK) {
    throw new Error('Plugin SDK is not initialized. Call initializePluginSDK() first.');
  }
  return cachedSDK;
}
