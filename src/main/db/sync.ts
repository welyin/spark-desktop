import { LevelDBOperation, LevelDB } from './base';
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
 * - 提供 applyRemoteUpdate（独立于 Collection 实现）
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

/**
 * 将远端更新合并到本地集合。
 * - collectionInstance 必须实现：get(id), db, and 私有方法 buildIndexMap/docKey/indexKey 可通过索引访问
 */
export async function applyRemoteUpdate<T = any>(
  db: LevelDB,
  collectionInstance: any,
  domain: string,
  collection: string,
  id: string,
  remotePayload: T | null,
  remoteMeta: { vv: Record<string, number>; ts: number; nodeId?: string }
) {
  const localMeta = await getMeta(db, domain, collection, id);
  const cmp = compareVersionVectors(localMeta ? localMeta.vv : null, remoteMeta ? remoteMeta.vv : null);
  if (cmp === 'remote') {
    if (remotePayload === null) {
      const local = await collectionInstance.get(id);
      if (local) {
        const ops: LevelDBOperation[] = [{ type: 'del', key: collectionInstance['docKey'](id) }];
        const idx = collectionInstance['buildIndexMap'](local);
        for (const [field, value] of idx.entries()) ops.push({ type: 'del', key: collectionInstance['indexKey'](field, value, id) });
        ops.push({ type: 'put', key: metaKey(domain, collection, id), value: JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts, tombstone: true }) });
        await db.batch(ops);
      } else {
        await db.put(metaKey(domain, collection, id), JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts, tombstone: true }));
      }
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
      ops.push({ type: 'put', key: metaKey(domain, collection, id), value: JSON.stringify({ vv: remoteMeta.vv, ts: remoteMeta.ts }) });
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
        if (collectionInstance['enableEvidence']) {
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
        if (collectionInstance['enableEvidence']) {
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
