import type { LevelDB } from '../db/base';
import { KeepaliveScheduler } from '../p2p/keepalive';
import { runAutoCleanup, type AutoCleanupResult } from './cleanup';
import { collectDataUsage, type DataUsageReport } from './usage';
import { AUTO_CLEANUP_MIN_INTERVAL_MS, DATA_MAINTENANCE_INTERVAL_MS } from './constants';

/**
 * 数据自动管理门面：
 * - 周期调度（1h tick）：距上次自动清理超 24h 执行 L1 清理；每次 tick 采样用量缓存；
 * - 手动入口（IPC 调用）：立即清理 / 刷新用量；
 * - start/stop 幂等，随 db-open/db-close 生命周期启停。
 *
 * 手动清理（purge）、水位线（watermark）与导出（exporter）为独立模块，
 * 由 IPC 层直接调用，不经过本门面。
 */
export class DataManagementService {
  private readonly scheduler: KeepaliveScheduler;
  private lastAutoCleanupAt = 0;
  private cachedUsage: DataUsageReport | null = null;

  constructor(private readonly db: LevelDB) {
    this.scheduler = new KeepaliveScheduler('data-maintenance', DATA_MAINTENANCE_INTERVAL_MS, async () => {
      await this.tick();
    });
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  isRunning(): boolean {
    return this.scheduler.isRunning();
  }

  /** 周期任务：到时自动清理 + 采样用量缓存（供 IPC 快读） */
  private async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAutoCleanupAt >= AUTO_CLEANUP_MIN_INTERVAL_MS) {
      const result = await runAutoCleanup(this.db);
      this.lastAutoCleanupAt = now;
      if (result.tombstones + result.peerRecords + result.orgSyncStates > 0) {
        // 清理改变了用量，使缓存失效，随本次 tick 重新采样
        this.cachedUsage = null;
      }
    }
    this.cachedUsage = await collectDataUsage(this.db, this.db.path);
  }

  /** 立即执行 L1 自动清理（IPC "立即清理"），随后刷新用量缓存 */
  async runCleanupNow(): Promise<AutoCleanupResult> {
    const result = await runAutoCleanup(this.db);
    this.lastAutoCleanupAt = Date.now();
    this.cachedUsage = null;
    return result;
  }

  /** 读取用量：优先缓存；无缓存（刚启动或失效）则现算 */
  async getUsage(): Promise<DataUsageReport> {
    if (!this.cachedUsage) {
      this.cachedUsage = await collectDataUsage(this.db, this.db.path);
    }
    return this.cachedUsage;
  }

  /**
   * 使用量缓存失效：供绕过本门面的写路径（如 IPC 直调的 purgeDomainDocs）调用，
   * 否则管理员清理后"刷新用量"最长看到 1 小时的陈旧数据
   */
  invalidateUsage(): void {
    this.cachedUsage = null;
  }
}
