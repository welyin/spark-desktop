import { app } from 'electron';
import { levelDB, ensureSystemDomainInitialized } from './db';
import { initP2PNode, getP2PNode, isP2PInitialized } from './p2p/index';
import { OrganizationService } from './organization/index';
import { rootIdentityManager } from './identity';
import { getUpdaterService } from './updater';

/**
 * 核心服务装配
 *
 * 组织服务单例与核心服务（LevelDB / P2P 节点）的启动编排集中在这里，
 * 避免 IPC 各模块各自维护启动逻辑。
 */

export const organizationService = new OrganizationService(levelDB, {
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

export function getCoreServicesLastError(): string | null {
  return coreServicesLastError;
}

export async function ensureCoreServicesStarted(): Promise<void> {
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
