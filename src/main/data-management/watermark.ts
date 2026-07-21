import type { LevelDB } from '../db/base';

/**
 * purge 水位线：记录"某集合在某时间点之前的数据已被本地清理"。
 *
 * 作用：防止已清理的数据被同步机制回灌——被清理的文档经远端重推时，
 * 其 meta 仍携带原始写入时间戳（必然早于水位线），applyRemoteUpdate
 * 据此跳过落地（见 db/sync.ts）。水位线只升不降，永不被清理流程删除。
 *
 * 存储在系统域（复用 collectionSchemaKey 的 encodeURIComponent 技巧），
 * 插件经底层 db 接口无法篡改。
 */

export interface PurgeWatermarkRecord {
  domain: string;
  collection: string;
  /** 该时间戳之前（严格小于）的文档已被清理，远端重推一律拒绝 */
  purgedBefore: number;
  /** 最近一次清理执行时间 */
  purgedAt: number;
  /** 累计清理文档数 */
  removedDocs: number;
}

const WATERMARK_KEY_PREFIX = 'doc:system:purge-watermark:';

export function purgeWatermarkKey(domain: string, collection: string): string {
  return `${WATERMARK_KEY_PREFIX}${encodeURIComponent(`${domain}/${collection}`)}`;
}

/** 读取集合的 purge 水位线；未清理过或记录损坏返回 null */
export async function getPurgeWatermark(
  db: LevelDB,
  domain: string,
  collection: string
): Promise<PurgeWatermarkRecord | null> {
  const raw = await db.get(purgeWatermarkKey(domain, collection));
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PurgeWatermarkRecord>;
    if (typeof parsed?.purgedBefore !== 'number') {
      return null;
    }
    return {
      domain,
      collection,
      purgedBefore: parsed.purgedBefore,
      purgedAt: typeof parsed.purgedAt === 'number' ? parsed.purgedAt : 0,
      removedDocs: typeof parsed.removedDocs === 'number' ? parsed.removedDocs : 0
    };
  } catch {
    return null;
  }
}

/**
 * 抬升集合的 purge 水位线（只升不降）：
 * purgedBefore 取新旧较大者，removedDocs 累计。返回生效后的记录。
 */
export async function raisePurgeWatermark(
  db: LevelDB,
  domain: string,
  collection: string,
  purgedBefore: number,
  removedDocs: number
): Promise<PurgeWatermarkRecord> {
  const existing = await getPurgeWatermark(db, domain, collection);
  const next: PurgeWatermarkRecord = {
    domain,
    collection,
    purgedBefore: Math.max(existing?.purgedBefore ?? 0, purgedBefore),
    purgedAt: Date.now(),
    removedDocs: (existing?.removedDocs ?? 0) + removedDocs
  };
  await db.put(purgeWatermarkKey(domain, collection), JSON.stringify(next));
  return next;
}

/**
 * 判定一个远端同步时间戳是否落在已清理区间：
 * 早于水位线（严格小于）即视为已清理，应拒绝落地。
 */
export async function isPurgedByWatermark(
  db: LevelDB,
  domain: string,
  collection: string,
  remoteTs: number
): Promise<boolean> {
  if (typeof remoteTs !== 'number' || remoteTs <= 0) {
    return false;
  }
  const watermark = await getPurgeWatermark(db, domain, collection);
  return watermark !== null && remoteTs < watermark.purgedBefore;
}
