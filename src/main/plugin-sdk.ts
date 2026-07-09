import type { IpcRenderer } from 'electron';
import type { DBStatus, LevelDBOperation } from './preload';

export interface PluginDBAPI {
  open: () => Promise<{ path: string; open: boolean }>;
  close: () => Promise<{ open: boolean }>;
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<{ success: boolean }>;
  del: (key: string) => Promise<{ success: boolean }>;
  batch: (operations: LevelDBOperation[]) => Promise<{ success: boolean }>;
  query: (prefix: string) => Promise<Array<{ key: string; value: string }>>;
  path: () => Promise<{ path: string }>;
  status: () => Promise<DBStatus>;
}

export interface PluginEvidenceAPI {
  headHash: () => Promise<{ hash: string | null }>;
  verify: () => Promise<{ valid: boolean; height: number }>;
}

export interface PluginP2PAPI {
  start: () => Promise<{ started: boolean }>;
  stop: () => Promise<{ started: boolean }>;
  broadcast: (topic: string, message: Record<string, any>) => Promise<{ success: boolean }>;
}

export interface PluginSDK {
  /** 当前插件的域身份，由主进程绑定，渲染端不可修改 */
  domain: string;
  db: PluginDBAPI;
  evidence: PluginEvidenceAPI;
  p2p: PluginP2PAPI;
}

/**
 * 创建插件 SDK 实例
 *
 * 安全说明：域身份由主进程在创建窗口时绑定，
 * 此工厂函数不再接收 domain 参数，而是从主进程查询当前窗口的可信域。
 * 渲染进程无法修改自身域身份。
 *
 * @param ipcRenderer IPC 渲染端实例
 * @returns 初始化后的 PluginSDK 实例
 * @throws 如果当前窗口未注册为插件域，抛出错误
 */
export async function createPluginSDK(ipcRenderer: IpcRenderer): Promise<PluginSDK> {
  const result = await ipcRenderer.invoke('get-current-domain');
  const domain = result?.domain;

  if (!domain || !domain.startsWith('plugin:') || domain.length <= 'plugin:'.length) {
    throw new Error(
      `Cannot create plugin SDK: current window domain is "${domain}". ` +
      'Plugin windows must be created with a plugin:xxx domain by the main process.'
    );
  }

  return {
    domain,
    db: {
      open: () => ipcRenderer.invoke('db-open'),
      close: () => ipcRenderer.invoke('db-close'),
      get: (key: string) => ipcRenderer.invoke('db-get', key),
      put: (key: string, value: string) => ipcRenderer.invoke('db-put', key, value),
      del: (key: string) => ipcRenderer.invoke('db-del', key),
      batch: (operations: LevelDBOperation[]) => ipcRenderer.invoke('db-batch', operations),
      query: (prefix: string) => ipcRenderer.invoke('db-query', prefix),
      path: () => ipcRenderer.invoke('db-path'),
      status: () => ipcRenderer.invoke('db-status')
    },
    evidence: {
      headHash: () => ipcRenderer.invoke('evidence-head-hash'),
      verify: () => ipcRenderer.invoke('evidence-verify')
    },
    p2p: {
      start: () => ipcRenderer.invoke('p2p-start'),
      stop: () => ipcRenderer.invoke('p2p-stop'),
      broadcast: (topic: string, message: Record<string, any>) =>
        ipcRenderer.invoke('p2p-broadcast', topic, message)
    }
  };
}
