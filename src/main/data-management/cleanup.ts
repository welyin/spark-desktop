import type { LevelDB } from '../db/base';
import { ORG_SYNC_STATE_PREFIX, P2P_PEER_RECORD_PREFIX } from '../p2p/constants';
import {
  KEY_RANGE_UPPER_BOUND,
  ORG_SYNC_STATE_RETENTION_MS,
  PEER_RECORD_RETENTION_MS,
  TOMBSTONE_RETENTION_MS
} from './constants';

/**
 * L1 级自动清理：只清"可重建 / 已终结"的状态，任何业务文档一律不动。
 *
 * 三类对象：
 * 1. lww 删除标记 tombstone（`meta:*` 值含 tombstone:true 且 ts 超过保留期）——
 *    收敛依赖存活副本持有的 tombstone：tombstone 被本地 GC 后，离线超过保留期的
 *    节点若重推更旧的 doc，会因本地 meta 缺失（LWW 判 remote 胜）而复活该文档，
 *    需靠仍持有 tombstone 的节点再次删除；若全网副本都已 GC 同一 tombstone，
 *    旧文档会网络级复活。90 天保留期即"最大离线窗口"的取舍：超期离线节点
 *    可能带回旧数据；
 * 2. p2p 节点活跃记录（`p2p:peer:record:*` lastSeenAt 超期）——纯本地状态，不走数据同步通道；
 * 3. p2p 组织同步记账（`p2p:org-sync-state:*` lastSyncedAt 超期）——
 *    K 副本 30 天新鲜窗口早已不计入，删除无感。
 */

export interface AutoCleanupResult {
  ranAt: number;
  tombstones: number;
  peerRecords: number;
  orgSyncStates: number;
}

interface ParsedRow {
  key: string;
  value: Record<string, unknown> | null;
}

async function scanRows(db: LevelDB, prefix: string): Promise<ParsedRow[]> {
  const rows = await db.queryRange({ prefix, start: prefix, end: `${prefix}${KEY_RANGE_UPPER_BOUND}` });
  return rows.map((row) => {
    try {
      return { key: row.key, value: JSON.parse(row.value) as Record<string, unknown> };
    } catch {
      return { key: row.key, value: null };
    }
  });
}

/** 清理过期 tombstone，返回删除数量 */
async function cleanupTombstones(db: LevelDB, now: number): Promise<number> {
  const rows = await scanRows(db, 'meta:');
  const expired = rows.filter(
    (row) =>
      row.value !== null &&
      row.value.tombstone === true &&
      typeof row.value.ts === 'number' &&
      now - row.value.ts > TOMBSTONE_RETENTION_MS
  );
  if (expired.length > 0) {
    await db.batch(expired.map((row) => ({ type: 'del' as const, key: row.key })));
  }
  return expired.length;
}

/** 清理过期 p2p 节点活跃记录，返回删除数量 */
async function cleanupPeerRecords(db: LevelDB, now: number): Promise<number> {
  const rows = await scanRows(db, P2P_PEER_RECORD_PREFIX);
  const expired = rows.filter(
    (row) =>
      row.value !== null &&
      typeof row.value.lastSeenAt === 'number' &&
      now - row.value.lastSeenAt > PEER_RECORD_RETENTION_MS
  );
  if (expired.length > 0) {
    await db.batch(expired.map((row) => ({ type: 'del' as const, key: row.key })));
  }
  return expired.length;
}

/** 清理过期组织同步记账，返回删除数量 */
async function cleanupOrgSyncStates(db: LevelDB, now: number): Promise<number> {
  const rows = await scanRows(db, ORG_SYNC_STATE_PREFIX);
  const expired = rows.filter(
    (row) =>
      row.value !== null &&
      typeof row.value.lastSyncedAt === 'number' &&
      now - row.value.lastSyncedAt > ORG_SYNC_STATE_RETENTION_MS
  );
  if (expired.length > 0) {
    await db.batch(expired.map((row) => ({ type: 'del' as const, key: row.key })));
  }
  return expired.length;
}

/** 执行一轮 L1 自动清理；各步独立，单步失败不影响其余类别 */
export async function runAutoCleanup(db: LevelDB): Promise<AutoCleanupResult> {
  const now = Date.now();
  const result: AutoCleanupResult = { ranAt: now, tombstones: 0, peerRecords: 0, orgSyncStates: 0 };

  try {
    result.tombstones = await cleanupTombstones(db, now);
  } catch (error) {
    console.warn('[data-management] tombstone cleanup failed', error);
  }
  try {
    result.peerRecords = await cleanupPeerRecords(db, now);
  } catch (error) {
    console.warn('[data-management] peer record cleanup failed', error);
  }
  try {
    result.orgSyncStates = await cleanupOrgSyncStates(db, now);
  } catch (error) {
    console.warn('[data-management] org sync-state cleanup failed', error);
  }

  if (result.tombstones + result.peerRecords + result.orgSyncStates > 0) {
    console.log('[data-management] auto cleanup done', result);
  }
  return result;
}
