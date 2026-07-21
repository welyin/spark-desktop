import { LevelDBOperation, LevelDB } from './base';
import { CollectionSchemaDeclaration, ResolvedCollectionPolicy, isSyncStrategy, resolveCollectionPolicy } from './schema';
import { isPurgedByWatermark } from '../data-management/watermark';
import {
  buildEvidenceDataHash,
  buildEvidenceMetaHash,
  buildEvidencePayloadHash,
  buildNextEvidenceEntry,
  evidenceBatchOperations
} from './evidence';

/**
 * 数据同步辅助模块：
 * - 提供 meta key 的生成与读写
 * - 提供版本向量比较与 LWW 决策
 * - 提供 applyRemoteUpdate：按集合声明的 syncStrategy 应用远端变更
 *   （append-only 仅接受新文档；lww 按版本向量 + 时间戳裁决）
 */

export function metaKey(domain: string, collection: string, id: string) {
  return `meta:${domain}:${collection}:${id}`;
}

export async function getMeta(db: LevelDB, domain: string, collection: string, id: string): Promise<any | null> {
  const raw = await db.get(metaKey(domain, collection, id));
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export async function setMeta(db: LevelDB, domain: string, collection: string, id: string, meta: any) {
  await db.put(metaKey(domain, collection, id), JSON.stringify(meta));
}

export async function generateUpdatedMeta(db: LevelDB, nodeId: string, domain: string, collection: string, id: string) {
  const raw = await getMeta(db, domain, collection, id);
  const meta = raw ?? { vv: {}, ts: 0, nodeId };
  meta.vv = meta.vv ?? {};
  meta.vv[nodeId] = (meta.vv[nodeId] ?? 0) + 1;
  meta.ts = Date.now();
  meta.nodeId = nodeId;
  return meta;
}

export function compareVersionVectors(local: Record<string, number> | null, remote: Record<string, number> | null) {
  if (!local && !remote) return 'equal';
  const keys = new Set<string>();
  if (local) Object.keys(local).forEach((k) => keys.add(k));
  if (remote) Object.keys(remote).forEach((k) => keys.add(k));
  let localGreater = false;
  let remoteGreater = false;
  for (const k of keys) {
    const lv = local && local[k] ? local[k] : 0;
    const rv = remote && remote[k] ? remote[k] : 0;
    if (lv > rv) localGreater = true;
    if (rv > lv) remoteGreater = true;
  }
  if (localGreater && !remoteGreater) return 'local';
  if (remoteGreater && !localGreater) return 'remote';
  if (localGreater && remoteGreater) return 'concurrent';
  return 'equal';
}

export function resolveConflictByLWW(localTs: number | null, remoteTs: number | null) {
  const l = localTs ?? 0;
  const r = remoteTs ?? 0;
  if (r > l) return 'remote';
  if (l > r) return 'local';
  return 'equal';
}

/** 合并版本向量（逐节点取大），用于 append-only 幂等去重后的收敛 */
function mergeVersionVectors(
  local: Record<string, number> | null,
  remote: Record<string, number> | null
): Record<string, number> {
  const merged: Record<string, number> = { ...(remote ?? {}) };
  for (const [nodeId, counter] of Object.entries(local ?? {})) {
    merged[nodeId] = Math.max(merged[nodeId] ?? 0, counter);
  }
  return merged;
}

/**
 * append-only 集合的远端应用：
 * - 本地不存在该文档：接受写入（附 meta 与存证）
 * - 本地已存在且载荷一致：幂等去重，合并版本向量促进收敛
 * - 本地已存在但载荷冲突 / 远端删除：拒绝并告警（不覆盖、不删除）
 */
async function applyRemoteAppendOnly<T>(
  db: LevelDB,
  collectionInstance: any,
  domain: string,
  collection: string,
  id: string,
  remotePayload: T | null,
  remoteMeta: { vv: Record<string, number>; ts: number; nodeId?: string },
  policy: ResolvedCollectionPolicy
) {
  if (remotePayload === null) {
    console.warn('[sync] append-only: drop remote delete', { domain, collection, id });
    return;
  }

  const local = await collectionInstance.get(id);
  const localMeta = await getMeta(db, domain, collection, id);

  if (!local) {
    const ops: LevelDBOperation[] = [
      { type: 'put', key: collectionInstance['docKey'](id), value: JSON.stringify(remotePayload) },
      { type: 'put', key: metaKey(domain, collection, id), value: JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts }) }
    ];
    const indexMap = collectionInstance['buildIndexMap'](remotePayload);
    for (const [field, value] of indexMap.entries()) {
      ops.push({ type: 'put', key: collectionInstance['indexKey'](field, value, id), value: '' });
    }
    if (policy.enableEvidence) {
      const evidenceEntry = await buildNextEvidenceEntry(db, {
        domain,
        collection,
        id,
        op: 'put',
        dataHash: buildEvidenceDataHash(domain, collection, id, 'put', buildEvidencePayloadHash(remotePayload), buildEvidenceMetaHash(remoteMeta)),
        payloadHash: buildEvidencePayloadHash(remotePayload),
        metaHash: buildEvidenceMetaHash(remoteMeta),
        timestamp: Date.now(),
        nodeId: remoteMeta.nodeId ?? 'remote-node'
      });
      ops.push(...evidenceBatchOperations(evidenceEntry));
    }
    await db.batch(ops);
    return;
  }

  if (buildEvidencePayloadHash(local) === buildEvidencePayloadHash(remotePayload)) {
    const mergedVv = mergeVersionVectors(localMeta?.vv ?? null, remoteMeta.vv ?? null);
    const mergedTs = Math.max(localMeta?.ts ?? 0, remoteMeta.ts ?? 0);
    const changed =
      JSON.stringify(mergedVv) !== JSON.stringify(localMeta?.vv ?? {}) || mergedTs !== (localMeta?.ts ?? 0);
    if (changed) {
      await db.put(metaKey(domain, collection, id), JSON.stringify({ vv: mergedVv, ts: mergedTs }));
    }
    return;
  }

  console.warn('[sync] append-only: conflicting payload for existing document, keep local', {
    domain,
    collection,
    id
  });
}

/**
 * 清洗同步消息携带的策略声明副本：
 * 仅作合法化校验（不合法返回 undefined），不做持久化——
 * 集合策略注册表只接受本地声明（见 db/schema.ts），网络来源永不写入，
 * 防止远端节点通过伪造声明锁死/降级本地集合策略。
 */
function sanitizeSchemaHint(hint: CollectionSchemaDeclaration | undefined): CollectionSchemaDeclaration | undefined {
  if (!hint || !isSyncStrategy(hint.syncStrategy)) {
    return undefined;
  }
  if (hint.governance === true && hint.syncStrategy !== 'append-only') {
    return undefined;
  }
  return {
    syncStrategy: hint.syncStrategy,
    governance: hint.governance === true,
    enableEvidence: hint.enableEvidence === true
  };
}

/**
 * 将远端更新合并到本地集合。
 * - collectionInstance 必须实现：get(id), db, and 私有方法 buildIndexMap/docKey/indexKey 可通过索引访问
 * - options.schema 为同步消息携带的策略声明副本：仅当本地未声明时，作为本次应用的兜底策略
 *   （瞬时生效，不持久化；本地已声明的策略始终优先，不受远端影响）
 */
export async function applyRemoteUpdate<T = any>(
  db: LevelDB,
  collectionInstance: any,
  domain: string,
  collection: string,
  id: string,
  remotePayload: T | null,
  remoteMeta: { vv: Record<string, number>; ts: number; nodeId?: string },
  options: { schema?: CollectionSchemaDeclaration } = {}
) {
  // purge 水位线拦截：本地手动清理过的时代（remoteMeta.ts 早于水位线）拒绝落地，
  // 防止已清理数据经推送/反熵拉取回灌。被清理文档重推时 meta 携带原始写入
  // 时间戳（必然早于水位线）；新写入的 ts 为写时时间，不会误伤。
  if (await isPurgedByWatermark(db, domain, collection, remoteMeta?.ts)) {
    console.log('[sync] skip remote update: purged by watermark', { domain, collection, id, ts: remoteMeta.ts });
    return;
  }

  const fallback = sanitizeSchemaHint(options.schema);
  if (options.schema && !fallback) {
    console.warn('[sync] ignore invalid remote collection schema hint', { domain, collection });
  }
  const policy = await resolveCollectionPolicy(db, domain, collection, fallback);

  if (policy.syncStrategy === 'append-only') {
    await applyRemoteAppendOnly(db, collectionInstance, domain, collection, id, remotePayload, remoteMeta, policy);
    return;
  }

  await applyRemoteLww(db, collectionInstance, domain, collection, id, remotePayload, remoteMeta, policy);
}

/** lww 集合的远端应用：版本向量判定新旧，并发冲突按时间戳裁决 */
async function applyRemoteLww<T = any>(
  db: LevelDB,
  collectionInstance: any,
  domain: string,
  collection: string,
  id: string,
  remotePayload: T | null,
  remoteMeta: { vv: Record<string, number>; ts: number; nodeId?: string },
  policy: ResolvedCollectionPolicy
) {
  const localMeta = await getMeta(db, domain, collection, id);
  const cmp = compareVersionVectors(localMeta ? localMeta.vv : null, remoteMeta ? remoteMeta.vv : null);
  if (cmp === 'remote') {
    if (remotePayload === null) {
      const local = await collectionInstance.get(id);
      const ops: LevelDBOperation[] = [];
      if (local) {
        ops.push({ type: 'del', key: collectionInstance['docKey'](id) });
        const idx = collectionInstance['buildIndexMap'](local);
        for (const [field, value] of idx.entries()) ops.push({ type: 'del', key: collectionInstance['indexKey'](field, value, id) });
      }
      const tombstoneValue = JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts, tombstone: true });
      ops.push({ type: 'put', key: metaKey(domain, collection, id), value: tombstoneValue });
      if (policy.enableEvidence) {
        const evidenceEntry = await buildNextEvidenceEntry(db, {
          domain,
          collection,
          id,
          op: 'delete',
          dataHash: buildEvidenceDataHash(domain, collection, id, 'delete', null, buildEvidenceMetaHash(JSON.parse(tombstoneValue))),
          payloadHash: null,
          metaHash: buildEvidenceMetaHash(JSON.parse(tombstoneValue)),
          timestamp: Date.now(),
          nodeId: remoteMeta.nodeId ?? 'remote-node'
        });
        ops.push(...evidenceBatchOperations(evidenceEntry));
      }
      await db.batch(ops);
    } else {
      const existing = await collectionInstance.get(id);
      const oldIndexMap = collectionInstance['buildIndexMap'](existing);
      const newIndexMap = collectionInstance['buildIndexMap'](remotePayload);
      const ops: LevelDBOperation[] = [{ type: 'put', key: collectionInstance['docKey'](id), value: JSON.stringify(remotePayload) }];
      for (const [field, oldValue] of oldIndexMap.entries()) {
        if (!newIndexMap.has(field) || newIndexMap.get(field) !== oldValue) ops.push({ type: 'del', key: collectionInstance['indexKey'](field, oldValue, id) });
      }
      for (const [field, newValue] of newIndexMap.entries()) {
        if (!oldIndexMap.has(field) || oldIndexMap.get(field) !== newValue) ops.push({ type: 'put', key: collectionInstance['indexKey'](field, newValue, id), value: '' });
      }
      const metaValue = JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts });
      ops.push({ type: 'put', key: metaKey(domain, collection, id), value: metaValue });
      if (policy.enableEvidence) {
        const evidenceEntry = await buildNextEvidenceEntry(db, {
          domain,
          collection,
          id,
          op: 'put',
          dataHash: buildEvidenceDataHash(domain, collection, id, 'put', buildEvidencePayloadHash(remotePayload), buildEvidenceMetaHash(JSON.parse(metaValue))),
          payloadHash: buildEvidencePayloadHash(remotePayload),
          metaHash: buildEvidenceMetaHash(JSON.parse(metaValue)),
          timestamp: Date.now(),
          nodeId: remoteMeta.nodeId ?? 'remote-node'
        });
        ops.push(...evidenceBatchOperations(evidenceEntry));
      }
      await db.batch(ops);
    }
    return;
  }

  if (cmp === 'local') {
    return;
  }

  if (cmp === 'concurrent') {
    const winner = resolveConflictByLWW(localMeta ? localMeta.ts : null, remoteMeta.ts);
    if (winner === 'remote') {
      if (remotePayload === null) {
        const local = await collectionInstance.get(id);
        const ops: LevelDBOperation[] = [];
        if (local) {
          ops.push({ type: 'del', key: collectionInstance['docKey'](id) });
          const idx = collectionInstance['buildIndexMap'](local);
          for (const [field, value] of idx.entries()) ops.push({ type: 'del', key: collectionInstance['indexKey'](field, value, id) });
        }
        const tombstoneValue = JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts, tombstone: true });
        ops.push({ type: 'put', key: metaKey(domain, collection, id), value: tombstoneValue });
        if (policy.enableEvidence) {
          const evidenceEntry = await buildNextEvidenceEntry(db, {
            domain,
            collection,
            id,
            op: 'delete',
            dataHash: buildEvidenceDataHash(domain, collection, id, 'delete', null, buildEvidenceMetaHash(JSON.parse(tombstoneValue))),
            payloadHash: null,
            metaHash: buildEvidenceMetaHash(JSON.parse(tombstoneValue)),
            timestamp: Date.now(),
            nodeId: remoteMeta.nodeId ?? 'remote-node'
          });
          ops.push(...evidenceBatchOperations(evidenceEntry));
        }
        await db.batch(ops);
      } else {
        const existing = await collectionInstance.get(id);
        const oldIndexMap = collectionInstance['buildIndexMap'](existing);
        const newIndexMap = collectionInstance['buildIndexMap'](remotePayload);
        const ops: LevelDBOperation[] = [{ type: 'put', key: collectionInstance['docKey'](id), value: JSON.stringify(remotePayload) }];
        for (const [field, oldValue] of oldIndexMap.entries()) {
          if (!newIndexMap.has(field) || newIndexMap.get(field) !== oldValue) ops.push({ type: 'del', key: collectionInstance['indexKey'](field, oldValue, id) });
        }
        for (const [field, newValue] of newIndexMap.entries()) {
          if (!oldIndexMap.has(field) || oldIndexMap.get(field) !== newValue) ops.push({ type: 'put', key: collectionInstance['indexKey'](field, newValue, id), value: '' });
        }
        const metaValue = JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts });
        ops.push({ type: 'put', key: metaKey(domain, collection, id), value: metaValue });
        if (policy.enableEvidence) {
          const evidenceEntry = await buildNextEvidenceEntry(db, {
            domain,
            collection,
            id,
            op: 'put',
            dataHash: buildEvidenceDataHash(domain, collection, id, 'put', buildEvidencePayloadHash(remotePayload), buildEvidenceMetaHash(JSON.parse(metaValue))),
            payloadHash: buildEvidencePayloadHash(remotePayload),
            metaHash: buildEvidenceMetaHash(JSON.parse(metaValue)),
            timestamp: Date.now(),
            nodeId: remoteMeta.nodeId ?? 'remote-node'
          });
          ops.push(...evidenceBatchOperations(evidenceEntry));
        }
        await db.batch(ops);
      }
    }
    return;
  }

  // equal -> nothing to do
}

export default {};
