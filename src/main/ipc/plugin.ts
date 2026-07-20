import { levelDB } from '../db';
import { getDeclaredPluginCollection, getPluginCollection } from '../db/plugin';
import { CollectionSchemaDeclaration, declareCollectionSchema } from '../db/schema';
import { isValidPluginDomain } from '../domain-registry';
import { rootIdentityManager, verifyEd25519Signature } from '../identity';
import { isP2PInitialized, getP2PNode } from '../p2p/index';
import { listPluginCatalog } from '../plugins/catalog';
import { organizationService, ensureCoreServicesStarted } from '../bootstrap';
import { createPluginWindow } from '../windows';
import { getCallerDomain, registerInvokeHandler, requirePluginPermission, requireSystemDomain } from './helpers';

/**
 * 插件运行时相关 IPC：窗口打开、目录查询、插件身份、组织与文档访问
 */
export function registerPluginHandlers(): void {
  registerInvokeHandler('plugin-open-view', (event, pluginDomain: string, pluginView = 'default') => {
    requireSystemDomain(event);

    if (!isValidPluginDomain(pluginDomain)) {
      throw new Error(`Invalid plugin domain: ${pluginDomain}`);
    }

    const view = typeof pluginView === 'string' && pluginView.trim().length > 0 ? pluginView : 'default';
    const pluginWindow = createPluginWindow(pluginDomain, view);
    return { success: true, windowId: pluginWindow.webContents.id };
  });

  registerInvokeHandler('plugin-list-catalog', (event) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    return listPluginCatalog();
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

  // 插件身份签名：以调用方绑定的插件域身份签名，根身份与域私钥均不离开主进程
  registerInvokeHandler('plugin-identity-sign', (event, payload: string, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'identity:sign', pluginDomain);
    if (typeof payload !== 'string' || payload.length === 0) {
      throw new Error('Payload is required');
    }
    return rootIdentityManager.signWithDomainIdentity(domain, payload);
  });

  // 纯验签（Ed25519），不含任何敏感数据，所有已注册域均可调用
  registerInvokeHandler('plugin-identity-verify', (event, payload: string, signature: string, publicKey: string) => {
    if (!getCallerDomain(event)) {
      throw new Error('Access denied: unregistered caller');
    }
    if (typeof payload !== 'string' || typeof signature !== 'string' || typeof publicKey !== 'string') {
      throw new Error('Payload, signature and publicKey are required');
    }
    return { valid: verifyEd25519Signature(payload, signature, publicKey) };
  });

  registerInvokeHandler('plugin-org-list-mine', async (event, pluginDomain?: string) => {
    requirePluginPermission(event, 'org:read', pluginDomain);
    return await organizationService.listMine();
  });

  registerInvokeHandler('plugin-org-sync-now', async (event, orgId: string, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'org:sync', pluginDomain);
    if (!orgId || typeof orgId !== 'string') {
      throw new Error('Organization id is required');
    }

    if (!isP2PInitialized() || !getP2PNode().isStarted()) {
      await ensureCoreServicesStarted();
    }

    const organizations = await organizationService.listMine();
    const target = organizations.find((item) => item.orgId === orgId);
    if (!target) {
      throw new Error('Organization not found or not joined');
    }

    if (target.basePluginDomain !== domain) {
      throw new Error('Organization does not belong to current plugin domain');
    }

    const status = await rootIdentityManager.getStatus();
    const currentRootId = status.rootId;
    if (!currentRootId) {
      throw new Error('Root identity is unavailable');
    }

    const candidates = target.members
      .filter((member) => member.rootId !== currentRootId && member.nodeInfo)
      .sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1));

    let attempted = 0;
    let pulled = 0;

    for (const member of candidates) {
      const nodeInfo = member.nodeInfo;
      if (!nodeInfo) {
        continue;
      }

      const hasPeer = Boolean(nodeInfo.peerId && nodeInfo.peerId.trim().length > 0);
      const hasAddress = Array.isArray(nodeInfo.addresses) && nodeInfo.addresses.length > 0;
      if (!hasPeer && !hasAddress) {
        continue;
      }

      attempted += 1;
      try {
        const result = await getP2PNode().pullOrganizationsFromPeer(nodeInfo);
        if (result.pulled > 0 || result.synced > 0) {
          pulled += 1;
        }
      } catch (error) {
        console.warn('[plugin-org-sync-now] pull failed', {
          orgId,
          memberRootId: member.rootId,
          error: String(error)
        });
      }
    }

    return {
      orgId,
      attempted,
      pulled
    };
  });

  registerInvokeHandler('plugin-doc-get', async (event, collection: string, id: string, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'storage:read', pluginDomain);
    const coll = getPluginCollection(levelDB, domain, collection);
    return await coll.get(id);
  });

  // 集合同步策略声明：syncStrategy 必填（append-only 默认 / lww 显式），声明后不可变更
  registerInvokeHandler('plugin-doc-declare-collection', async (event, collection: string, schema: CollectionSchemaDeclaration, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'storage:write', pluginDomain);
    const record = await declareCollectionSchema(levelDB, domain, collection, schema);
    return {
      collection: record.collection,
      syncStrategy: record.syncStrategy,
      governance: record.governance,
      enableEvidence: record.enableEvidence
    };
  });

  registerInvokeHandler('plugin-doc-put', async (event, collection: string, id: string, doc: Record<string, unknown>, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'storage:write', pluginDomain);
    const { coll } = await getDeclaredPluginCollection(levelDB, domain, collection);
    await coll.put(id, doc);
    return { success: true };
  });

  registerInvokeHandler('plugin-doc-delete', async (event, collection: string, id: string, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'storage:write', pluginDomain);
    const { coll } = await getDeclaredPluginCollection(levelDB, domain, collection);
    await coll.delete(id);
    return { success: true };
  });

  registerInvokeHandler('plugin-doc-query', async (event, collection: string, options: { limit?: number; reverse?: boolean; filter?: Array<{ field: string; value: string | number | boolean; op?: 'eq' | 'startsWith' | 'gt' | 'lt' | 'gte' | 'lte' }> } = {}, pluginDomain?: string) => {
    const domain = requirePluginPermission(event, 'storage:read', pluginDomain);
    const coll = getPluginCollection(levelDB, domain, collection);
    return await coll.query(options);
  });
}
