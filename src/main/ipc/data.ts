import { dialog } from 'electron';
import { levelDB } from '../db';
import { isP2PInitialized, getP2PNode } from '../p2p/index';
import { ensureCoreServicesStarted, organizationService, dataManagementService } from '../bootstrap';
import { previewPurgeDomainDocs, purgeDomainDocs, writeExportDump } from '../data-management';
import { registerInvokeHandler, requireSystemDomain } from './helpers';

/**
 * 数据自动管理 IPC（全部系统域）：
 * - data-usage / data-cleanup-now / data-export：用量、L1 自动清理、手动导出；
 * - data-purge-preview / data-purge-execute：管理员手动清理组织域旧数据，
 *   硬前提：当前用户是该组织管理员 + 已确认导出 + K 副本充足。
 */
export function registerDataHandlers(): void {
  /** 进行中的 purge 域：selectExpiredMetas → batch 非原子，并发两次 execute 会让统计重复计数 */
  const purgeInFlight = new Set<string>();

  const ensureReady = async () => {
    if (!levelDB.isOpen) {
      await ensureCoreServicesStarted();
    }
  };

  /** 解析目标组织并校验存在性与域信息 */
  const resolveOrg = async (orgId: string) => {
    const orgs = await organizationService.listMine();
    const org = orgs.find((item) => item.orgId === orgId);
    if (!org) {
      throw new Error('Organization not found or not a member');
    }
    if (!org.basePluginDomain) {
      throw new Error(`Organization ${orgId} has no base plugin domain; cannot locate its data domain`);
    }
    return org;
  };

  /** 组织 K 副本概览（清理前校验用）；P2P 未启动视为无法满足硬前提 */
  const getReplicaOverview = async (orgId: string) => {
    if (!isP2PInitialized() || !getP2PNode().isStarted()) {
      return null;
    }
    return getP2PNode().getOrgSyncOverview(orgId);
  };

  registerInvokeHandler('data-usage', async (event) => {
    requireSystemDomain(event);
    await ensureReady();
    return dataManagementService.getUsage();
  });

  registerInvokeHandler('data-cleanup-now', async (event) => {
    requireSystemDomain(event);
    await ensureReady();
    return dataManagementService.runCleanupNow();
  });

  registerInvokeHandler('data-export', async (event) => {
    requireSystemDomain(event);
    await ensureReady();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const picked = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: `spark-export-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePath) {
      return { cancelled: true };
    }
    const result = await writeExportDump(levelDB, picked.filePath);
    return { cancelled: false, ...result };
  });

  registerInvokeHandler('data-purge-preview', async (event, orgId: string, beforeTs: number) => {
    requireSystemDomain(event);
    await ensureReady();
    const org = await resolveOrg(orgId);
    const preview = await previewPurgeDomainDocs(levelDB, { domain: org.basePluginDomain!, beforeTs });
    return {
      orgId,
      domain: org.basePluginDomain,
      beforeTs,
      preview,
      replica: await getReplicaOverview(orgId),
      isCurrentUserAdmin: org.isCurrentUserAdmin
    };
  });

  registerInvokeHandler(
    'data-purge-execute',
    async (event, orgId: string, beforeTs: number, confirmExported: boolean) => {
      requireSystemDomain(event);
      await ensureReady();
      const org = await resolveOrg(orgId);

      // 手动清理治理数据的三个硬前提：管理员身份、已导出转移、K 副本充足
      if (!org.isCurrentUserAdmin) {
        throw new Error('Only organization admins can purge historical data');
      }
      if (confirmExported !== true) {
        throw new Error('Export backup first: confirmExported must be true before purging');
      }
      const replica = await getReplicaOverview(orgId);
      if (!replica) {
        throw new Error('P2P network is not started; cannot verify replica sufficiency, purge refused');
      }
      if (replica.syncedPeers < replica.replicaTarget) {
        throw new Error(
          `Replica insufficient (${replica.syncedPeers}/${replica.replicaTarget}): purging local copies now may lose organization data. ` +
            'Wait for replicas to replenish or add disk space instead.'
        );
      }

      if (purgeInFlight.has(org.basePluginDomain!)) {
        throw new Error(`A purge for domain ${org.basePluginDomain} is already running; wait for it to finish`);
      }
      purgeInFlight.add(org.basePluginDomain!);
      try {
        const result = await purgeDomainDocs(levelDB, { domain: org.basePluginDomain!, beforeTs });
        // purge 直调绕过了 DataManagementService，手动失效用量缓存
        dataManagementService.invalidateUsage();
        return result;
      } finally {
        purgeInFlight.delete(org.basePluginDomain!);
      }
    }
  );
}
