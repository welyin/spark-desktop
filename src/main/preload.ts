import { contextBridge, ipcRenderer } from 'electron';

console.log('[preload.ts] start');

export type DBStatus = {
  open: boolean;
};

export type LevelDBOperation = {
  type: 'put' | 'del';
  key: string;
  value?: string;
};

export type ElectronAPI = {
  db: {
    open: () => Promise<{ path: string; open: boolean }>;
    close: () => Promise<{ open: boolean }>;
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<{ success: boolean }>;
    del: (key: string) => Promise<{ success: boolean }>;
    batch: (operations: LevelDBOperation[]) => Promise<{ success: boolean }>;
    query: (prefix: string) => Promise<Array<{ key: string; value: string }>>;
    path: () => Promise<{ path: string }>;
    status: () => Promise<DBStatus>;
  };
  evidence: {
    headHash: () => Promise<{ hash: string | null }>;
    verify: () => Promise<{ valid: boolean; height: number }>;
  };
  p2p: {
    start: () => Promise<{ started: boolean }>;
    stop: () => Promise<{ started: boolean }>;
    broadcast: (topic: string, message: any) => Promise<{ success: boolean }>;
  };
  plugin: {
    openView: (pluginDomain: string, pluginView?: string) => Promise<{ success: boolean; windowId: number }>;
  };
  organization: {
    listMine: () => Promise<Array<{
      orgId: string;
      name: string;
      description: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>>;
    create: (input: { name: string; description?: string }) => Promise<{
      orgId: string;
      name: string;
      description: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>;
    delete: (orgId: string) => Promise<{ success: boolean }>;
    addMember: (orgId: string, memberRootId: string) => Promise<{
      orgId: string;
      name: string;
      description: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>;
    removeMember: (orgId: string, memberRootId: string) => Promise<{
      orgId: string;
      name: string;
      description: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>;
  };
  rootIdentity: {
    status: () => Promise<{ initialized: boolean; unlocked: boolean; rootId: string | null }>;
    initialize: (password: string) => Promise<{ rootId: string; mnemonic: string }>;
    unlock: (password: string) => Promise<{ rootId: string }>;
    lock: () => Promise<{ success: boolean }>;
    sign: (payload: string) => Promise<{ rootId: string; signature: string; payloadHash: string }>;
    deriveDomain: (domain: string) => Promise<{ domain: string; domainId: string; publicKey: string; derivationPath: string }>;
  };
  /**
   * 查询当前窗口的可信域身份（只读）
   * 域身份由主进程在创建窗口时绑定，渲染进程无法修改
   */
  getDomain: () => Promise<{ domain: string | null }>;
};

const api = {
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
    broadcast: (topic: string, message: any) => ipcRenderer.invoke('p2p-broadcast', topic, message)
  },
  plugin: {
    openView: (pluginDomain: string, pluginView = 'default') =>
      ipcRenderer.invoke('plugin-open-view', pluginDomain, pluginView)
  },
  organization: {
    listMine: () => ipcRenderer.invoke('org-list-mine'),
    create: (input: { name: string; description?: string }) => ipcRenderer.invoke('org-create', input),
    delete: (orgId: string) => ipcRenderer.invoke('org-delete', orgId),
    addMember: (orgId: string, memberRootId: string) => ipcRenderer.invoke('org-add-member', orgId, memberRootId),
    removeMember: (orgId: string, memberRootId: string) => ipcRenderer.invoke('org-remove-member', orgId, memberRootId)
  },
  rootIdentity: {
    status: () => ipcRenderer.invoke('root-status'),
    initialize: (password: string) => ipcRenderer.invoke('root-init', password),
    unlock: (password: string) => ipcRenderer.invoke('root-unlock', password),
    lock: () => ipcRenderer.invoke('root-lock'),
    sign: (payload: string) => ipcRenderer.invoke('root-sign', payload),
    deriveDomain: (domain: string) => ipcRenderer.invoke('root-derive-domain', domain)
  },
  getDomain: () => ipcRenderer.invoke('get-current-domain')
};

console.log('[preload.ts] exposing electronAPI');
contextBridge.exposeInMainWorld('electronAPI', api as ElectronAPI);
