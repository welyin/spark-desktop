import type { LevelDB, LevelDBOperation } from '../db/base';
import { KEY_RANGE_UPPER_BOUND } from './constants';
import { raisePurgeWatermark } from './watermark';

/**
 * 手动清理执行器（L2 级：治理类/业务文档仅在管理员手动触发时可清）。
 *
 * 语义：删除指定插件域（可选限定集合）中 meta.ts 早于 beforeTs 的全部本地副本
 * （doc + idx + meta，含同时代 tombstone），并把每个受影响集合的 purge 水位线
 * 抬升到 beforeTs——后续远端重推同时代数据会被 applyRemoteUpdate 拒绝，
 * 本地清理不会因 K 副本同步而回灌（见 watermark.ts 与 db/sync.ts）。
 *
 * 与并发同步的竞态（可自愈，特此说明）：选中到 batch 之间若某选中 id 恰好
 * 收到 ts >= beforeTs 的远端新写入，该新值会被一并删除；水位线不拦截它
 * （其 ts 高于水位线），但后续反熵会从其他副本补回——结果正确，依赖同步收敛。
 *
 * 硬性边界（防御性强制）：
 * - 只接受 plugin: 域——系统域（策略/水位线/审计日志）、存证链、组织与 p2p 状态
 *   永远不在本路径清理范围；
 * - 无 meta 的文档无法判定年代，保守跳过不删；
 * - 存证链是全局单链，删除中间环节会破坏整链验证，本路径从不触碰。
 */

export interface PurgeOptions {
  domain: string;
  beforeTs: number;
  /** 可选：只清理该集合；缺省清理域内全部集合 */
  collection?: string;
}

export interface PurgeResult {
  domain: string;
  beforeTs: number;
  collections: string[];
  removedDocs: number;
  freedBytes: number;
  purgedAt: number;
}

const PURGE_LOG_PREFIX = 'doc:system:purge-log:';

interface SelectedMeta {
  collection: string;
  id: string;
  key: string;
  bytes: number;
}

/** 选中待清理的 meta 条目（ts < beforeTs），并校验目标域合法性 */
async function selectExpiredMetas(db: LevelDB, options: PurgeOptions): Promise<SelectedMeta[]> {
  if (!options.domain.startsWith('plugin:') || options.domain.length <= 'plugin:'.length) {
    throw new Error(`Refused to purge non-plugin domain "${options.domain}": only plugin domains can be purged`);
  }
  if (typeof options.beforeTs !== 'number' || options.beforeTs <= 0) {
    throw new Error('beforeTs must be a positive timestamp');
  }

  const metaPrefix = options.collection ? `meta:${options.domain}:${options.collection}:` : `meta:${options.domain}:`;
  const rows = await db.queryRange({ prefix: metaPrefix, start: metaPrefix, end: `${metaPrefix}${KEY_RANGE_UPPER_BOUND}` });

  const selected: SelectedMeta[] = [];
  for (const row of rows) {
    // 键剩余部分为 {collection}:{id}；collection 名不含冒号（schema.ts 约束），
    // id 取第一个冒号之后的全部内容，对含冒号的 id 同样精确
    const remainder = row.key.slice(`meta:${options.domain}:`.length);
    const separator = remainder.indexOf(':');
    if (separator <= 0 || separator === remainder.length - 1) {
      continue;
    }
    const collection = remainder.slice(0, separator);
    const id = remainder.slice(separator + 1);

    let ts: number | null = null;
    try {
      const parsed = JSON.parse(row.value) as { ts?: unknown };
      ts = typeof parsed?.ts === 'number' ? parsed.ts : null;
    } catch {
      // 损坏的 meta 无法判定年代，保守跳过
    }
    if (ts === null || ts >= options.beforeTs) {
      continue;
    }

    selected.push({
      collection,
      id,
      key: row.key,
      bytes: Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8')
    });
  }
  return selected;
}

/** 汇总选中条目的 doc/idx 体量与删除操作（不执行） */
async function buildPurgePlan(
  db: LevelDB,
  domain: string,
  selected: SelectedMeta[]
): Promise<{ ops: LevelDBOperation[]; freedBytes: number }> {
  const ops: LevelDBOperation[] = [];
  let freedBytes = 0;

  const byCollection = new Map<string, SelectedMeta[]>();
  for (const item of selected) {
    const list = byCollection.get(item.collection) ?? [];
    list.push(item);
    byCollection.set(item.collection, list);
  }

  for (const [collection, items] of byCollection.entries()) {
    // doc：存在才删，计入释放体量（无 meta 的 doc 不在选中集内，不会误删）
    const docPrefix = `doc:${domain}:${collection}:`;
    const docRows = await db.queryRange({ prefix: docPrefix, start: docPrefix, end: `${docPrefix}${KEY_RANGE_UPPER_BOUND}` });
    const selectedIds = new Set(items.map((item) => item.id));
    for (const row of docRows) {
      const id = row.key.slice(docPrefix.length);
      if (!selectedIds.has(id)) {
        continue;
      }
      ops.push({ type: 'del', key: row.key });
      freedBytes += Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8');
    }

    // meta：选中集全删（含同时代 tombstone，水位线会拦截同时代重推）
    for (const item of items) {
      ops.push({ type: 'del', key: item.key });
      freedBytes += item.bytes;
    }

    // idx：键为 idx:{domain}:{collection}:{indexName}:{encValue}:{id}，
    // 只能按尾部 ":{id}" 匹配——若系统未来允许 id 内含冒号，
    // "a:b" 的索引会被 "b" 的清理误匹配；当前各环节产生的 id 均不含冒号。
    // 扫描上界统一用 KEY_RANGE_UPPER_BOUND（见 constants.ts），非 ASCII id 不漏扫
    const idxPrefix = `idx:${domain}:${collection}:`;
    const idxRows = await db.queryRange({ prefix: idxPrefix, start: idxPrefix, end: `${idxPrefix}${KEY_RANGE_UPPER_BOUND}` });
    for (const row of idxRows) {
      for (const item of items) {
        if (row.key.endsWith(`:${item.id}`)) {
          ops.push({ type: 'del', key: row.key });
          freedBytes += Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8');
          break;
        }
      }
    }
  }

  return { ops, freedBytes };
}

/** 预览清理影响面：不删除任何数据 */
export async function previewPurgeDomainDocs(
  db: LevelDB,
  options: PurgeOptions
): Promise<{ collections: string[]; affectedDocs: number; affectedBytes: number }> {
  const selected = await selectExpiredMetas(db, options);
  const { freedBytes } = await buildPurgePlan(db, options.domain, selected);
  const collections = [...new Set(selected.map((item) => item.collection))];
  // affectedDocs 以 meta（每文档恰好一条）计数；affectedBytes 含 doc/meta/idx 三类
  return { collections, affectedDocs: selected.length, affectedBytes: freedBytes };
}

/**
 * 执行手动清理：
 * 1) 删除选中时代的 doc/idx/meta；2) 抬升各集合 purge 水位线；3) 追加审计日志。
 */
export async function purgeDomainDocs(db: LevelDB, options: PurgeOptions): Promise<PurgeResult> {
  const selected = await selectExpiredMetas(db, options);
  const purgedAt = Date.now();
  const collections = [...new Set(selected.map((item) => item.collection))];

  if (selected.length === 0) {
    return { domain: options.domain, beforeTs: options.beforeTs, collections, removedDocs: 0, freedBytes: 0, purgedAt };
  }

  const { ops, freedBytes } = await buildPurgePlan(db, options.domain, selected);
  await db.batch(ops);

  // 水位线先于返回抬升：此后同时代远端重推一律被拒绝，清理不会被同步回灌
  for (const collection of collections) {
    const removedInCollection = selected.filter((item) => item.collection === collection).length;
    await raisePurgeWatermark(db, options.domain, collection, options.beforeTs, removedInCollection);
  }

  const logKey = `${PURGE_LOG_PREFIX}${purgedAt}`;
  await db.put(
    logKey,
    JSON.stringify({
      domain: options.domain,
      collection: options.collection ?? null,
      beforeTs: options.beforeTs,
      collections,
      removedDocs: selected.length,
      freedBytes,
      purgedAt
    })
  );

  console.log('[data-management] manual purge done', {
    domain: options.domain,
    collection: options.collection ?? null,
    beforeTs: options.beforeTs,
    removedDocs: selected.length,
    freedBytes
  });

  return { domain: options.domain, beforeTs: options.beforeTs, collections, removedDocs: selected.length, freedBytes, purgedAt };
}
