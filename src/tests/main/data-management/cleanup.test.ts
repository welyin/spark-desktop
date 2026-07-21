import { describe, expect, it } from 'vitest';
import { runAutoCleanup } from '../../../main/data-management/cleanup';
import { ORG_SYNC_STATE_RETENTION_MS, PEER_RECORD_RETENTION_MS, TOMBSTONE_RETENTION_MS } from '../../../main/data-management/constants';
import { MemoryDb } from './helpers';

const NOW = Date.now();
const OLD = NOW - 91 * 24 * 60 * 60 * 1000;
const FRESH = NOW - 1000;

describe('runAutoCleanup (L1)', () => {
  it('removes expired tombstones only, keeps fresh tombstones and non-tombstone metas', async () => {
    const db = new MemoryDb();
    await db.put('meta:plugin:test:posts:p1', JSON.stringify({ vv: { a: 1 }, ts: NOW - TOMBSTONE_RETENTION_MS - 1000, tombstone: true }));
    await db.put('meta:plugin:test:posts:p2', JSON.stringify({ vv: { a: 2 }, ts: FRESH, tombstone: true }));
    await db.put('meta:plugin:test:posts:p3', JSON.stringify({ vv: { a: 3 }, ts: OLD }));
    // 损坏值不崩溃也不误删
    await db.put('meta:plugin:test:posts:p4', 'not-json');

    const result = await runAutoCleanup(db as any);

    expect(result.tombstones).toBe(1);
    expect(await db.get('meta:plugin:test:posts:p1')).toBe(null);
    expect(await db.get('meta:plugin:test:posts:p2')).not.toBe(null);
    expect(await db.get('meta:plugin:test:posts:p3')).not.toBe(null);
    expect(await db.get('meta:plugin:test:posts:p4')).not.toBe(null);
  });

  it('removes expired peer activity records and org sync states', async () => {
    const db = new MemoryDb();
    await db.put('p2p:peer:record:peerA', JSON.stringify({ peerId: 'peerA', lastSeenAt: NOW - PEER_RECORD_RETENTION_MS - 1000 }));
    await db.put('p2p:peer:record:peerB', JSON.stringify({ peerId: 'peerB', lastSeenAt: FRESH }));
    await db.put('p2p:org-sync-state:peerA:org1', JSON.stringify({ lastSyncedAt: NOW - ORG_SYNC_STATE_RETENTION_MS - 1000, versions: {} }));
    await db.put('p2p:org-sync-state:peerB:org1', JSON.stringify({ lastSyncedAt: FRESH, versions: {} }));
    // 其他 p2p 键（身份/端口/覆盖网邻居池）一律不动
    await db.put('p2p:identity:privateKey', 'secret');
    await db.put('p2p:overlay:peer:peerX', JSON.stringify({ peerId: 'peerX', lastSeenAt: OLD }));

    const result = await runAutoCleanup(db as any);

    expect(result.peerRecords).toBe(1);
    expect(result.orgSyncStates).toBe(1);
    expect(await db.get('p2p:peer:record:peerA')).toBe(null);
    expect(await db.get('p2p:peer:record:peerB')).not.toBe(null);
    expect(await db.get('p2p:org-sync-state:peerA:org1')).toBe(null);
    expect(await db.get('p2p:org-sync-state:peerB:org1')).not.toBe(null);
    expect(await db.get('p2p:identity:privateKey')).toBe('secret');
    expect(await db.get('p2p:overlay:peer:peerX')).not.toBe(null);
  });

  it('never touches business documents, evidence, organization or system keys', async () => {
    const db = new MemoryDb();
    const untouched = [
      ['doc:plugin:test:posts:p1', JSON.stringify({ name: 'ancient' })],
      ['idx:plugin:test:posts:name:ancient:p1', ''],
      ['meta:plugin:test:posts:p1', JSON.stringify({ vv: { a: 1 }, ts: OLD })],
      ['doc:evidence:proof:000000000001', JSON.stringify({ seq: 1 })],
      ['doc:system:collection-schema:x', JSON.stringify({ declaredAt: OLD })],
      ['org:meta:org1', JSON.stringify({ createdAt: OLD })],
      ['org:tx:org1:1:tx1', JSON.stringify({ createdAt: OLD })]
    ] as const;
    for (const [key, value] of untouched) {
      await db.put(key, value);
    }

    const result = await runAutoCleanup(db as any);

    expect(result.tombstones + result.peerRecords + result.orgSyncStates).toBe(0);
    for (const [key, value] of untouched) {
      expect(await db.get(key)).toBe(value);
    }
  });

  it('removes expired tombstones with non-ASCII ids that a \\xFF upper bound would silently miss', async () => {
    const db = new MemoryDb();
    await db.put('meta:plugin:test:posts:文档一', JSON.stringify({ vv: { a: 1 }, ts: NOW - TOMBSTONE_RETENTION_MS - 1000, tombstone: true }));

    const result = await runAutoCleanup(db as any);

    expect(result.tombstones).toBe(1);
    expect(await db.get('meta:plugin:test:posts:文档一')).toBe(null);
  });
});
