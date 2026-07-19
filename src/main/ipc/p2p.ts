import { levelDB } from '../db';
import { isValidPluginDomain } from '../domain-registry';
import { rootIdentityManager } from '../identity';
import { isP2PInitialized, getP2PNode } from '../p2p/index';
import { ensureCoreServicesStarted, getCoreServicesLastError } from '../bootstrap';
import { getCallerDomain, registerInvokeHandler, requireAccess, requirePluginPermission, requireSystemDomain } from './helpers';

/**
 * P2P 网络相关 IPC
 */
export function registerP2PHandlers(): void {
  registerInvokeHandler('p2p-start', async (event) => {
    requireSystemDomain(event);
    if (!isP2PInitialized() || !levelDB.isOpen) {
      await ensureCoreServicesStarted();
    }
    await getP2PNode().start();
    return { started: getP2PNode().isStarted() };
  });

  registerInvokeHandler('p2p-stop', async (event) => {
    requireSystemDomain(event);
    if (!isP2PInitialized()) {
      return { started: false };
    }
    await getP2PNode().stop();
    return { started: getP2PNode().isStarted() };
  });

  registerInvokeHandler('p2p-broadcast', async (event, topic: string, message: any) => {
    const targetDomain = message?.domain ?? null;
    requireAccess(event, targetDomain);
    const caller = getCallerDomain(event);
    if (caller && isValidPluginDomain(caller)) {
      requirePluginPermission(event, 'network:broadcast');
    }
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
        error: getCoreServicesLastError()
      };
    }

    const info = getP2PNode().getLocalNodeInfo();
    return {
      ...info,
      error: getCoreServicesLastError()
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

  registerInvokeHandler('p2p-clear-peer-records', async (event) => {
    requireSystemDomain(event);

    if (!isP2PInitialized()) {
      await ensureCoreServicesStarted();
    }

    return await getP2PNode().clearSavedPeerRecords();
  });
}
