import { app, powerMonitor } from 'electron';
import { access, rename } from 'fs/promises';
import path from 'path';
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

/** 每个用户一个独立的 LevelDB 目录（多用户数据隔离，类系统多账户） */
export function storageNameForRootId(rootId: string): string {
  return `spark-leveldb-${rootId.slice(0, 16)}`;
}

/**
 * 让 LevelDB 指向当前活跃身份的专属库目录：不一致时先完整停机
 * （保活/数据治理/P2P/关库），再重指向。服务单例持有的是 levelDB 对象
 * 引用而非路径，重指向后透明生效；P2P 节点每次 start 都从库里现读身份
 */
export async function ensureStorageMatchesIdentity(): Promise<void> {
  const rootId = await rootIdentityManager.getActiveRootId();
  if (!rootId) {
    return;
  }
  const target = storageNameForRootId(rootId);
  if (levelDB.name === target) {
    return;
  }
  console.log('[main] switching storage for active user', { from: levelDB.name, to: target });
  stopOrganizationKeepalive();
  stopDataMaintenance();
  if (isP2PInitialized() && getP2PNode().isStarted()) {
    await getP2PNode().stop();
  }
  if (levelDB.isOpen) {
    await levelDB.close();
  }
  levelDB.reconfigure(target);
}

/**
 * 旧版单用户库目录迁移：spark-leveldb → spark-leveldb-<rootId16>。
 * 仅在启动早期（库尚未打开）调用。
 * 注：目标目录已存在时旧目录原样保留（仅"降级再升级"边缘场景会出现），
 * 自动删除用户数据目录的风险大于磁盘占用，故不清理
 */
export async function migrateLegacyStorageIfNeeded(): Promise<void> {
  const rootId = await rootIdentityManager.getActiveRootId();
  if (!rootId || levelDB.isOpen) {
    return;
  }
  const userData = app.getPath('userData');
  const legacyPath = path.join(userData, 'spark-leveldb');
  const targetPath = path.join(userData, storageNameForRootId(rootId));
  try {
    await access(targetPath);
    return; // 已是按用户布局
  } catch {
    // 目标不存在，继续尝试迁移
  }
  try {
    await rename(legacyPath, targetPath);
    console.log('[main] migrated legacy leveldb dir to per-user storage');
  } catch {
    // 无旧库目录（新装或已迁移）
  }
}

let coreServicesChain: Promise<void> = Promise.resolve();

/** 串行入队，避免切用户时的"停机→换库→重启"与并发 ensureReady 交叠 */
function enqueueCoreServices(task: () => Promise<void>): Promise<void> {
  const run = coreServicesChain.then(task);
  coreServicesChain = run.catch(() => {
    // 失败不污染后续调用链
  });
  return run;
}

async function doEnsureStorageReady(): Promise<void> {
  await ensureStorageMatchesIdentity();
  await levelDB.open();
  try {
    await ensureSystemDomainInitialized(levelDB);
    console.log('[main] system domain initialized');
  } catch (err) {
    console.error('[main] failed to initialize system domain', err);
  }
}

/**
 * 快速路径（登录/注册/恢复 IPC 返回前必须 await）：只做到存储对齐 + 开库，
 * 保证渲染进程随后的查询不会命中上一个用户的库或关库窗口
 */
export function ensureStorageReady(): Promise<void> {
  return enqueueCoreServices(doEnsureStorageReady);
}

/** 串行化的核心服务启动入口（含 P2P 启动与保活，可留后台执行） */
export function ensureCoreServicesStarted(): Promise<void> {
  return enqueueCoreServices(doEnsureCoreServicesStarted);
}

async function doEnsureCoreServicesStarted(): Promise<void> {
  try {
    await doEnsureStorageReady();

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
