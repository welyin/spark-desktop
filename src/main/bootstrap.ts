import { app, powerMonitor } from 'electron';
import { levelDB, ensureSystemDomainInitialized } from './db';
import { initP2PNode, getP2PNode, isP2PInitialized } from './p2p/index';
import { KeepaliveScheduler } from './p2p/keepalive';
import { buildNodeInfoClaimPayload, OrganizationService } from './organization/index';
import type { NodeInfoClaim } from './organization/index';
import { DataManagementService } from './data-management';
import { rootIdentityManager } from './identity';
import { getUpdaterService } from './updater';

/**
 * 核心服务装配
 *
 * 组织服务单例与核心服务（LevelDB / P2P 节点）的启动编排集中在这里，
 * 避免 IPC 各模块各自维护启动逻辑。
 */

/** 组织网络保活周期（60s）：候选拨号 + 反熵拉取 + 管理员补副本 */
const ORG_KEEPALIVE_INTERVAL_MS = 60_000;

/**
 * 构建当前身份的签名 nodeInfoClaim（邀请加入与周期性重宣告共用）。
 * 家用宽带公网 IPv4 会变化、IPv6 前缀也会重新分配，claim 需随每次拉取
 * 重新签名捎带，让对端落库并 gossip 扩散最新地址。
 */
async function buildSelfNodeInfoClaim(): Promise<NodeInfoClaim | null> {
  if (!isP2PInitialized() || !getP2PNode().isStarted()) {
    return null;
  }
  const status = await rootIdentityManager.getStatus();
  const publicKey = rootIdentityManager.getUnlockedPublicKeyBase64();
  if (!status.unlocked || !status.rootId || !publicKey) {
    return null;
  }
  const local = getP2PNode().getLocalNodeInfo();
  const unsigned = {
    type: 'spark-node-info-claim' as const,
    version: 1 as const,
    rootId: status.rootId,
    publicKey,
    nodeInfo: { peerId: local.peerId ?? undefined, addresses: local.addresses },
    timestamp: Date.now()
  };
  const signed = rootIdentityManager.signWithRootIdentity(buildNodeInfoClaimPayload(unsigned));
  return { ...unsigned, signature: signed.signature };
}

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
}, {
  // 邀请码引导加入：邀请人生码、被邀请人凭码直连回拉；
  // 被邀请人随首次 pull 捎带签名 nodeInfoClaim，供管理员回填其节点地址
  getLocalNodeInfo: async () => {
    if (!isP2PInitialized()) {
      return { peerId: null, addresses: [] };
    }
    const info = getP2PNode().getLocalNodeInfo();
    return { peerId: info.peerId, addresses: info.addresses };
  },
  connectAndPull: async (nodeInfo, extras) => {
    if (!isP2PInitialized() || !getP2PNode().isStarted()) {
      throw new Error('P2P 网络未启动，无法通过邀请码加入');
    }
    const result = await getP2PNode().pullOrganizationsFromPeer(nodeInfo, extras);
    return { pulled: result.pulled };
  },
  buildSelfNodeInfoClaim
});

let coreServicesLastError: string | null = null;

export function getCoreServicesLastError(): string | null {
  return coreServicesLastError;
}

let orgKeepaliveScheduler: KeepaliveScheduler | null = null;
let powerMonitorHooked = false;

/** 幂等启动组织网络保活循环（p2p 启动后调用；db-close 时由 stopOrganizationKeepalive 停止） */
function ensureOrganizationKeepaliveStarted(): void {
  if (!orgKeepaliveScheduler) {
    orgKeepaliveScheduler = new KeepaliveScheduler('org-network', ORG_KEEPALIVE_INTERVAL_MS, async () => {
      if (isP2PInitialized() && getP2PNode().isStarted()) {
        await getP2PNode().maintainOrganizationNetwork();
      }
    });
  }
  orgKeepaliveScheduler.start();

  if (!powerMonitorHooked) {
    powerMonitorHooked = true;
    powerMonitor.on('resume', () => {
      console.log('[main] system resumed, trigger organization keepalive tick');
      orgKeepaliveScheduler?.notifyResumed();
    });
  }
}

export function stopOrganizationKeepalive(): void {
  orgKeepaliveScheduler?.stop();
}

/** 数据自动管理服务（随核心服务启动，db-close 时停止） */
export const dataManagementService = new DataManagementService(levelDB);

export function stopDataMaintenance(): void {
  dataManagementService.stop();
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
        },
        onNodeInfoClaim: async (claim, context) => {
          await organizationService.applyNodeInfoClaim(claim as NodeInfoClaim, context);
        },
        getSelfNodeInfoClaim: buildSelfNodeInfoClaim,
        getRecoveryView: async () => organizationService.getRecoveryView()
      });
      console.log('[main] p2p node initialized with db');
    }

    if (!getP2PNode().isStarted()) {
      await getP2PNode().start();
      console.log('[main] p2p node started automatically');
    }

    ensureOrganizationKeepaliveStarted();
    dataManagementService.start();

    coreServicesLastError = null;
  } catch (error) {
    coreServicesLastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
