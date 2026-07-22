import { contextBridge, ipcRenderer } from 'electron';
import type { PluginPermission } from './plugins/permissions';
import type { DomainSignature } from './identity/root-id';

console.log('[preload.ts] start');

export type DBStatus = {
  open: boolean;
};

/** data-usage 返回的分类用量报告（与 main/data-management/usage.ts 对齐） */
export type DataUsageReportDto = {
  scannedAt: number;
  classes: Record<
    'documents' | 'indexes' | 'syncMeta' | 'evidence' | 'organization' | 'p2p' | 'system' | 'other',
    { keys: number; bytes: number }
  >;
  totalKeys: number;
  totalBytes: number;
  disk: { path: string; freeBytes: number; totalBytes: number; freeRatio: number } | null;
  warnings: { usageExceeded: boolean; diskLow: boolean };
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
    clearPeerRecords: () => Promise<{ cleared: number }>;
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
      permissions: PluginPermission[];
      package: {
        updateManifestUrl: string;
        signatureUrl: string;
        packageName: string;
        installCommand: string;
      };
    }>>;
    currentRoot: () => Promise<{ unlocked: boolean; rootId: string | null }>;
    identitySign: (payload: string, pluginDomain?: string) => Promise<DomainSignature>;
    identityVerify: (payload: string, signature: string, publicKey: string) => Promise<{ valid: boolean }>;
    syncOrganizationData: (orgId: string, pluginDomain?: string) => Promise<{ orgId: string; attempted: number; pulled: number }>;
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
    docDeclareCollection: (
      collection: string,
      schema: { syncStrategy: 'append-only' | 'lww'; governance?: boolean; enableEvidence?: boolean },
      pluginDomain?: string
    ) => Promise<{
      collection: string;
      syncStrategy: 'append-only' | 'lww';
      governance: boolean;
      enableEvidence: boolean;
    }>;
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
      permissions: PluginPermission[];
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
    addMember: (orgId: string, input: { rootId: string; nodeInfo?: { peerId?: string; addresses: string[] } }) => Promise<{
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
    createInvite: (orgId: string) => Promise<{ invite: string; orgId: string; orgName: string }>;
    acceptInvite: (code: string) => Promise<{ orgId: string; orgName: string; memberCount: number }>;
    getSyncOverview: (orgId: string) => Promise<{
      orgId: string;
      replicaTarget: number;
      syncedPeers: number;
      totalMembers: number;
      members: Array<{
        rootId: string;
        peerId?: string;
        isSelf: boolean;
        everSynced: boolean;
        lastSyncedAt: number | null;
      }>;
    } | null>;
  };
  rootIdentity: {
    status: () => Promise<{ initialized: boolean; unlocked: boolean; rootId: string | null; nickname: string | null; avatar: string | null }>;
    initialize: (password: string, nickname: string, avatar?: string | null) => Promise<{ rootId: string; mnemonic: string }>;
    unlock: (password: string, rootId?: string) => Promise<{ rootId: string }>;
    lock: () => Promise<{ success: boolean }>;
    sign: (payload: string) => Promise<{ rootId: string; signature: string; payloadHash: string }>;
    deriveDomain: (domain: string) => Promise<{ domain: string; domainId: string; publicKey: string; derivationPath: string }>;
    /** 本设备已知身份列表（切换用户） */
    listIdentities: () => Promise<Array<{ rootId: string; createdAt: number; active: boolean; nickname: string | null; avatar: string | null }>>;
    /** 切换登录目标用户（仅改指针，解锁时生效） */
    setActive: (rootId: string) => Promise<{ success: boolean }>;
    /** 更新当前登录用户的昵称/头像（avatar 传 null 恢复自动头像） */
    updateProfile: (profile: { nickname?: string | null; avatar?: string | null }) => Promise<{ nickname: string | null; avatar: string | null }>;
    /** 密码门控再次查看助记词 */
    revealMnemonic: (password: string) => Promise<{ mnemonic: string }>;
    /** 导出加密备份载荷（备份二维码内容，密文不敏感） */
    backupPayload: () => Promise<{ payload: string }>;
    /** 录入助记词时逐词校验（返回词数组与词表外词下标，供高亮） */
    checkMnemonic: (input: string) => Promise<{ words: string[]; invalidIndexes: number[] }>;
    /** 助记词恢复（最高权限，设置新密码与昵称） */
    recoverMnemonic: (mnemonic: string, newPassword: string, nickname: string, avatar?: string | null) => Promise<{ rootId: string }>;
    /** 加密备份二维码恢复（需原登录密码；昵称/头像随备份携带） */
    recoverBackup: (payload: string, password: string) => Promise<{ rootId: string }>;
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
  dataManagement: {
    usage: () => Promise<DataUsageReportDto>;
    cleanupNow: () => Promise<{ ranAt: number; tombstones: number; peerRecords: number; orgSyncStates: number }>;
    exportData: () => Promise<{ cancelled: true } | { cancelled: false; path: string; entries: number; bytes: number }>;
    purgePreview: (orgId: string, beforeTs: number) => Promise<{
      orgId: string;
      domain: string;
      beforeTs: number;
      preview: { collections: string[]; affectedDocs: number; affectedBytes: number };
      replica: {
        orgId: string;
        replicaTarget: number;
        syncedPeers: number;
        totalMembers: number;
        members: Array<{
          rootId: string;
          peerId?: string;
          isSelf: boolean;
          everSynced: boolean;
          lastSyncedAt: number | null;
        }>;
      } | null;
      isCurrentUserAdmin: boolean;
    }>;
    purgeExecute: (orgId: string, beforeTs: number, confirmExported: boolean) => Promise<{
      domain: string;
      beforeTs: number;
      collections: string[];
      removedDocs: number;
      freedBytes: number;
      purgedAt: number;
    }>;
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
    clearPeerRecords: () => ipcRenderer.invoke('p2p-clear-peer-records'),
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
    identitySign: (payload: string, pluginDomain?: string) => ipcRenderer.invoke('plugin-identity-sign', payload, pluginDomain),
    identityVerify: (payload: string, signature: string, publicKey: string) =>
      ipcRenderer.invoke('plugin-identity-verify', payload, signature, publicKey),
    syncOrganizationData: (orgId: string, pluginDomain?: string) => ipcRenderer.invoke('plugin-org-sync-now', orgId, pluginDomain),
    listMineOrganizations: (pluginDomain?: string) => ipcRenderer.invoke('plugin-org-list-mine', pluginDomain),
    docGet: (collection: string, id: string, pluginDomain?: string) => ipcRenderer.invoke('plugin-doc-get', collection, id, pluginDomain),
    docDeclareCollection: (
      collection: string,
      schema: { syncStrategy: 'append-only' | 'lww'; governance?: boolean; enableEvidence?: boolean },
      pluginDomain?: string
    ) => ipcRenderer.invoke('plugin-doc-declare-collection', collection, schema, pluginDomain),
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
    addMember: (orgId: string, input: { rootId: string; nodeInfo?: { peerId?: string; addresses: string[] } }) => ipcRenderer.invoke('org-add-member', orgId, input),
    removeMember: (orgId: string, memberRootId: string) => ipcRenderer.invoke('org-remove-member', orgId, memberRootId),
    createInvite: (orgId: string) => ipcRenderer.invoke('org-invite-create', orgId),
    acceptInvite: (code: string) => ipcRenderer.invoke('org-invite-accept', code),
    getSyncOverview: (orgId: string) => ipcRenderer.invoke('org-sync-overview', orgId)
  },
  rootIdentity: {
    status: () => ipcRenderer.invoke('root-status'),
    initialize: (password: string, nickname: string, avatar?: string | null) => ipcRenderer.invoke('root-init', password, nickname, avatar ?? null),
    unlock: (password: string, rootId?: string) => ipcRenderer.invoke('root-unlock', password, rootId),
    lock: () => ipcRenderer.invoke('root-lock'),
    sign: (payload: string) => ipcRenderer.invoke('root-sign', payload),
    deriveDomain: (domain: string) => ipcRenderer.invoke('root-derive-domain', domain),
    listIdentities: () => ipcRenderer.invoke('root-list-identities'),
    setActive: (rootId: string) => ipcRenderer.invoke('root-set-active', rootId),
    updateProfile: (profile: { nickname?: string | null; avatar?: string | null }) => ipcRenderer.invoke('root-update-profile', profile),
    revealMnemonic: (password: string) => ipcRenderer.invoke('root-reveal-mnemonic', password),
    backupPayload: () => ipcRenderer.invoke('root-backup-payload'),
    checkMnemonic: (input: string) => ipcRenderer.invoke('root-mnemonic-check', input),
    recoverMnemonic: (mnemonic: string, newPassword: string, nickname: string, avatar?: string | null) =>
      ipcRenderer.invoke('root-recover-mnemonic', mnemonic, newPassword, nickname, avatar ?? null),
    recoverBackup: (payload: string, password: string) => ipcRenderer.invoke('root-recover-backup', payload, password)
  },
  updater: {
    status: () => ipcRenderer.invoke('update-status'),
    check: () => ipcRenderer.invoke('update-check'),
    stageLatest: () => ipcRenderer.invoke('update-stage-latest'),
    applyRestart: () => ipcRenderer.invoke('update-apply-restart'),
    observePeerVersion: (version: string) => ipcRenderer.invoke('update-observe-peer-version', version)
  },
  dataManagement: {
    usage: () => ipcRenderer.invoke('data-usage'),
    cleanupNow: () => ipcRenderer.invoke('data-cleanup-now'),
    exportData: () => ipcRenderer.invoke('data-export'),
    purgePreview: (orgId: string, beforeTs: number) => ipcRenderer.invoke('data-purge-preview', orgId, beforeTs),
    purgeExecute: (orgId: string, beforeTs: number, confirmExported: boolean) =>
      ipcRenderer.invoke('data-purge-execute', orgId, beforeTs, confirmExported)
  },
  getDomain: () => ipcRenderer.invoke('get-current-domain')
};

console.log('[preload.ts] exposing electronAPI');
contextBridge.exposeInMainWorld('electronAPI', api as ElectronAPI);
