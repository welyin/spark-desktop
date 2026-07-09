import type { ElectronAPI } from '../main/preload';
import type { PluginSDK } from '../main/plugin-sdk';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

let cachedSDK: PluginSDK | null = null;

/**
 * 初始化插件 SDK
 *
 * 安全说明：域身份由主进程在创建插件窗口时绑定，
 * 渲染端无法指定或修改域。此函数仅验证当前窗口是否已注册为合法插件域。
 *
 * @throws 如果 electronAPI 不可用，或当前窗口不是插件域
 */
export async function initializePluginSDK(): Promise<PluginSDK> {
  if (!window.electronAPI) {
    throw new Error('electronAPI is not available in the renderer context');
  }

  const result = await window.electronAPI.getDomain();
  const domain = result?.domain;

  if (!domain || !domain.startsWith('plugin:')) {
    throw new Error(
      `Plugin SDK initialization failed: current window domain is "${domain}". ` +
      'Plugin windows must be created with a plugin: domain by the main process.'
    );
  }

  cachedSDK = {
    domain,
    db: window.electronAPI.db,
    evidence: window.electronAPI.evidence,
    p2p: window.electronAPI.p2p
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
