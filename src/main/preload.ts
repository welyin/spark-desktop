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
    syncPeerOrganizations: (targetPeer: { peerId?: string; addresses: string[] }) => Promise<{
      attempted: number;
      synced: number;
      pullChecked: number;
      pullSynced: number;
      removed: number;
    }>;
    info: () => Promise<{
      initialized: boolean;
      started: boolean;
      peerId: string | null;
      addresses: string[];
      connectedPeers: string[];
      sparkSyncSubscribers: string[];
      error?: string | null;
    }>;
  };
  plugin: {
    openView: (pluginDomain: string, pluginView?: string) => Promise<{ success: boolean; windowId: number }>;
    listCatalog: () => Promise<Array<{
      id: string;
      domain: string;
      name: string;
      description: string;
      category: 'foundation' | 'business';
      version: string;
      views: string[];
      package: {
        updateManifestUrl: string;
        signatureUrl: string;
        packageName: string;
        installCommand: string;
      };
    }>>;
    currentRoot: () => Promise<{ unlocked: boolean; rootId: string | null }>;
    listMineOrganizations: (pluginDomain?: string) => Promise<Array<{
      orgId: string;
      name: string;
      description: string;
      basePluginDomain?: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
        nodeInfo?: {
          peerId?: string;
          addresses: string[];
        };
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>>;
    docGet: <T extends Record<string, unknown> = Record<string, unknown>>(collection: string, id: string, pluginDomain?: string) => Promise<T | null>;
    docPut: (collection: string, id: string, doc: Record<string, unknown>, pluginDomain?: string) => Promise<{ success: boolean }>;
    docDelete: (collection: string, id: string, pluginDomain?: string) => Promise<{ success: boolean }>;
    docQuery: <T extends Record<string, unknown> = Record<string, unknown>>(
      collection: string,
      options?: {
        limit?: number;
        reverse?: boolean;
        filter?: Array<{
          field: string;
          value: string | number | boolean;
          op?: 'eq' | 'startsWith' | 'gt' | 'lt' | 'gte' | 'lte';
        }>;
      },
      pluginDomain?: string
    ) => Promise<{
      items: Array<{ id: string; data: T }>;
      nextCursor?: string;
    }>;
  };
  pluginMarket: {
    list: () => Promise<Array<{
      id: string;
      domain: string;
      name: string;
      description: string;
      category: 'foundation' | 'business';
      version: string;
      views: string[];
      package: {
        updateManifestUrl: string;
        signatureUrl: string;
        packageName: string;
        installCommand: string;
      };
      installed: boolean;
      enabled: boolean;
      installedVersion: string | null;
      latestVersion: string | null;
      updateAvailable: boolean;
      lastCheckedAt: number | null;
      lastCheckReason: string;
    }>>;
    checkUpdates: (pluginId?: string) => Promise<Array<{
      pluginId: string;
      checkedAt: number;
      latestVersion: string | null;
      updateAvailable: boolean;
      reason: string;
    }>>;
    install: (pluginId: string) => Promise<{
      pluginId: string;
      version: string;
      packagePath: string;
      sha256: string;
      size: number;
      installedAt: number;
      enabled: boolean;
    }>;
    upgrade: (pluginId: string) => Promise<{
      pluginId: string;
      version: string;
      packagePath: string;
      sha256: string;
      size: number;
      installedAt: number;
      enabled: boolean;
    }>;
    setEnabled: (pluginId: string, enabled: boolean) => Promise<{
      pluginId: string;
      version: string;
      packagePath: string;
      sha256: string;
      size: number;
      installedAt: number;
      enabled: boolean;
    }>;
  };
  organization: {
    listMine: () => Promise<Array<{
      orgId: string;
      name: string;
      description: string;
      basePluginDomain?: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
        nodeInfo?: {
          peerId?: string;
          addresses: string[];
        };
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>>;
    create: (input: { name: string; description?: string; basePluginDomain: string }) => Promise<{
      orgId: string;
      name: string;
      description: string;
      basePluginDomain?: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
        nodeInfo?: {
          peerId?: string;
          addresses: string[];
        };
      }>;
      currentUserRole: 'admin' | 'member' | null;
      isCurrentUserAdmin: boolean;
      memberCount: number;
      adminCount: number;
    }>;
    delete: (orgId: string) => Promise<{ success: boolean }>;
    addMember: (orgId: string, input: { rootId: string; nodeInfo: { peerId?: string; addresses: string[] } }) => Promise<{
      orgId: string;
      name: string;
      description: string;
      basePluginDomain?: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
        nodeInfo?: {
          peerId?: string;
          addresses: string[];
        };
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
      basePluginDomain?: string;
      createdAt: number;
      createdBy: string;
      updatedAt: number;
      members: Array<{
        rootId: string;
        role: 'admin' | 'member';
        joinedAt: number;
        addedBy: string;
        nodeInfo?: {
          peerId?: string;
          addresses: string[];
        };
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
  updater: {
    status: () => Promise<{
      configured: boolean;
      appId: string;
      channel: 'stable' | 'canary';
      currentVersion: string;
      highestAcceptedVersion: string;
      latestCheck: {
        checkedAt: number;
        source: 'manual' | 'startup' | 'peer-observed';
        currentVersion: string;
        availableVersion: string | null;
        updateAvailable: boolean;
        critical: boolean;
        revokedCurrentVersion: boolean;
        reason: string;
      } | null;
      staged: {
        version: string;
        filePath: string;
        fileName: string;
        sha256: string;
        size: number;
        stagedAt: number;
      } | null;
      peerObservations: Array<{
        peerId: string;
        observedVersion: string;
        observedAt: number;
        triggeredCheck: boolean;
      }>;
    }>;
    check: () => Promise<{
      checkedAt: number;
      source: 'manual' | 'startup' | 'peer-observed';
      currentVersion: string;
      availableVersion: string | null;
      updateAvailable: boolean;
      critical: boolean;
      revokedCurrentVersion: boolean;
      reason: string;
    }>;
    stageLatest: () => Promise<{
      version: string;
      filePath: string;
      fileName: string;
      sha256: string;
      size: number;
      stagedAt: number;
    }>;
    applyRestart: () => Promise<{ success: boolean }>;
    observePeerVersion: (version: string) => Promise<{ success: boolean }>;
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
    broadcast: (topic: string, message: any) => ipcRenderer.invoke('p2p-broadcast', topic, message),
    syncPeerOrganizations: (targetPeer: { peerId?: string; addresses: string[] }) => {
      const payload = {
        peerId: targetPeer?.peerId,
        addresses: Array.isArray(targetPeer?.addresses)
          ? targetPeer.addresses.map((item) => String(item))
          : []
      };
      return ipcRenderer.invoke('p2p-sync-peer-organizations', payload);
    },
    info: () => ipcRenderer.invoke('p2p-info')
  },
  plugin: {
    openView: (pluginDomain: string, pluginView = 'default') =>
      ipcRenderer.invoke('plugin-open-view', pluginDomain, pluginView),
    listCatalog: () => ipcRenderer.invoke('plugin-list-catalog'),
    currentRoot: () => ipcRenderer.invoke('plugin-current-root'),
    listMineOrganizations: (pluginDomain?: string) => ipcRenderer.invoke('plugin-org-list-mine', pluginDomain),
    docGet: (collection: string, id: string, pluginDomain?: string) => ipcRenderer.invoke('plugin-doc-get', collection, id, pluginDomain),
    docPut: (collection: string, id: string, doc: Record<string, unknown>, pluginDomain?: string) =>
      ipcRenderer.invoke('plugin-doc-put', collection, id, doc, pluginDomain),
    docDelete: (collection: string, id: string, pluginDomain?: string) =>
      ipcRenderer.invoke('plugin-doc-delete', collection, id, pluginDomain),
    docQuery: (collection: string, options = {}, pluginDomain?: string) =>
      ipcRenderer.invoke('plugin-doc-query', collection, options, pluginDomain)
  },
  pluginMarket: {
    list: () => ipcRenderer.invoke('plugin-market-list'),
    checkUpdates: (pluginId?: string) => ipcRenderer.invoke('plugin-market-check-updates', pluginId),
    install: (pluginId: string) => ipcRenderer.invoke('plugin-market-install', pluginId),
    upgrade: (pluginId: string) => ipcRenderer.invoke('plugin-market-upgrade', pluginId),
    setEnabled: (pluginId: string, enabled: boolean) =>
      ipcRenderer.invoke('plugin-market-set-enabled', pluginId, enabled)
  },
  organization: {
    listMine: () => ipcRenderer.invoke('org-list-mine'),
    create: (input: { name: string; description?: string; basePluginDomain: string }) => ipcRenderer.invoke('org-create', input),
    delete: (orgId: string) => ipcRenderer.invoke('org-delete', orgId),
    addMember: (orgId: string, input: { rootId: string; nodeInfo: { peerId?: string; addresses: string[] } }) => ipcRenderer.invoke('org-add-member', orgId, input),
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
  updater: {
    status: () => ipcRenderer.invoke('update-status'),
    check: () => ipcRenderer.invoke('update-check'),
    stageLatest: () => ipcRenderer.invoke('update-stage-latest'),
    applyRestart: () => ipcRenderer.invoke('update-apply-restart'),
    observePeerVersion: (version: string) => ipcRenderer.invoke('update-observe-peer-version', version)
  },
  getDomain: () => ipcRenderer.invoke('get-current-domain')
};

console.log('[preload.ts] exposing electronAPI');
contextBridge.exposeInMainWorld('electronAPI', api as ElectronAPI);
