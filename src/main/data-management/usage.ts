import { statfs } from 'fs/promises';
import type { LevelDB } from '../db/base';
import { DISK_FREE_WARN_RATIO, KEY_RANGE_UPPER_BOUND, USAGE_WARN_TOTAL_BYTES } from './constants';

/**
 * 存储用量统计（软配额的数据来源）。
 *
 * 全库扫描一遍按键前缀分类聚合；社区规模数据量下单次扫描开销可忽略。
 * 只测量与提示，不拒绝任何写入（软配额）。
 */

export type UsageClass =
  | 'documents' // 业务文档 doc:plugin:* / doc:<domain>:*
  | 'indexes' // 二级索引 idx:*
  | 'syncMeta' // 同步元数据 meta:*（含 tombstone）
  | 'evidence' // 存证链 doc:evidence:*
  | 'organization' // 组织 org:meta:* / org:tx:*
  | 'p2p' // p2p 网络状态 p2p:*
  | 'system' // 系统域 doc:system:*（策略注册表、purge 水位线、配置）
  | 'other';

export interface UsageClassStat {
  keys: number;
  bytes: number;
}

export interface DiskInfo {
  path: string;
  freeBytes: number;
  totalBytes: number;
  freeRatio: number;
}

export interface DataUsageReport {
  scannedAt: number;
  classes: Record<UsageClass, UsageClassStat>;
  totalKeys: number;
  totalBytes: number;
  disk: DiskInfo | null;
  warnings: {
    /** 数据总量超过软配额阈值 */
    usageExceeded: boolean;
    /** 磁盘可用比例低于阈值 */
    diskLow: boolean;
  };
}

/** 按存储键前缀归类（顺序敏感：更具体的前缀先判） */
export function classifyKey(key: string): UsageClass {
  if (key.startsWith('doc:evidence:')) return 'evidence';
  if (key.startsWith('doc:system:')) return 'system';
  if (key.startsWith('doc:')) return 'documents';
  if (key.startsWith('idx:')) return 'indexes';
  if (key.startsWith('meta:')) return 'syncMeta';
  if (key.startsWith('org:')) return 'organization';
  if (key.startsWith('p2p:')) return 'p2p';
  return 'other';
}

function emptyClasses(): Record<UsageClass, UsageClassStat> {
  return {
    documents: { keys: 0, bytes: 0 },
    indexes: { keys: 0, bytes: 0 },
    syncMeta: { keys: 0, bytes: 0 },
    evidence: { keys: 0, bytes: 0 },
    organization: { keys: 0, bytes: 0 },
    p2p: { keys: 0, bytes: 0 },
    system: { keys: 0, bytes: 0 },
    other: { keys: 0, bytes: 0 }
  };
}

/** 读取数据目录所在磁盘的可用空间；失败返回 null（不影响用量统计） */
export async function measureDiskInfo(path: string): Promise<DiskInfo | null> {
  try {
    const stats = await statfs(path);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
      return null;
    }
    return { path, freeBytes, totalBytes, freeRatio: freeBytes / totalBytes };
  } catch {
    return null;
  }
}

/**
 * 全库扫描并分类聚合用量。
 * diskPath 提供时附带磁盘可用信息（statfs 失败静默为 null）。
 */
export async function collectDataUsage(db: LevelDB, diskPath?: string): Promise<DataUsageReport> {
  const classes = emptyClasses();
  let totalKeys = 0;
  let totalBytes = 0;

  // end 取最大合法 UTF-8 码位，保证非 ASCII 键也被遍历到
  const rows = await db.queryRange({ prefix: '', end: KEY_RANGE_UPPER_BOUND });
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8');
    const stat = classes[classifyKey(row.key)];
    stat.keys += 1;
    stat.bytes += bytes;
    totalKeys += 1;
    totalBytes += bytes;
  }

  const disk = diskPath ? await measureDiskInfo(diskPath) : null;

  return {
    scannedAt: Date.now(),
    classes,
    totalKeys,
    totalBytes,
    disk,
    warnings: {
      usageExceeded: totalBytes > USAGE_WARN_TOTAL_BYTES,
      diskLow: disk !== null && disk.freeRatio < DISK_FREE_WARN_RATIO
    }
  };
}
