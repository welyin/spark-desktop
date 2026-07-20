import { levelDB, parseDomainFromKey, getEvidenceHeadHash, verifyEvidenceChain, getEvidenceHeight } from '../db';
import { isValidPluginDomain } from '../domain-registry';
import { isP2PInitialized, getP2PNode } from '../p2p/index';
import { ensureCoreServicesStarted, stopOrganizationKeepalive } from '../bootstrap';
import { getCallerDomain, registerInvokeHandler, requireAccess, requirePluginPermission, requireSystemDomain } from './helpers';

/**
 * 数据库与链式存证相关 IPC
 */
export function registerDbHandlers(): void {
  registerInvokeHandler('db-open', async (event) => {
    requireSystemDomain(event);
    await ensureCoreServicesStarted();

    return { path: levelDB.path, open: levelDB.isOpen };
  });

  registerInvokeHandler('db-close', async (event) => {
    requireSystemDomain(event);
    // 先停保活循环，避免 tick 在 p2p 停止/数据库关闭后继续访问
    stopOrganizationKeepalive();
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
    const caller = getCallerDomain(event);
    if (!caller) {
      throw new Error('Access denied: unregistered caller');
    }
    if (isValidPluginDomain(caller)) {
      requirePluginPermission(event, 'proof:verify');
    }
    return { hash: await getEvidenceHeadHash(levelDB) };
  });

  registerInvokeHandler('evidence-verify', async (event) => {
    const caller = getCallerDomain(event);
    if (!caller) {
      throw new Error('Access denied: unregistered caller');
    }
    if (isValidPluginDomain(caller)) {
      requirePluginPermission(event, 'proof:verify');
    }
    return { valid: await verifyEvidenceChain(levelDB), height: await getEvidenceHeight(levelDB) };
  });
}
