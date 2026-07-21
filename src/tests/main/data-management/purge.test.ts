import { describe, expect, it } from 'vitest';
import { previewPurgeDomainDocs, purgeDomainDocs } from '../../../main/data-management/purge';
import { getPurgeWatermark } from '../../../main/data-management/watermark';
import { applyRemoteUpdate, metaKey } from '../../../main/db/sync';
import { MemoryDb, createCollectionStub } from './helpers';

const DOMAIN = 'plugin:test';
const OLD_TS = 100;
const NEW_TS = 1000;
const BEFORE_TS = 500;

/** 构造一个带 doc/meta/idx 的完整文档与一条 tombstone */
async function seedDomain(db: MemoryDb) {
  // 旧文档 p1（ts=100，清理对象）
  await db.put(`doc:${DOMAIN}:posts:p1`, JSON.stringify({ name: 'old-post' }));
  await db.put(metaKey(DOMAIN, 'posts', 'p1'), JSON.stringify({ vv: { a: 1 }, ts: OLD_TS }));
  await db.put(`idx:${DOMAIN}:posts:name:old-post:p1`, '');
  // 新文档 p2（ts=1000，必须保留）
  await db.put(`doc:${DOMAIN}:posts:p2`, JSON.stringify({ name: 'new-post' }));
  await db.put(metaKey(DOMAIN, 'posts', 'p2'), JSON.stringify({ vv: { a: 2 }, ts: NEW_TS }));
  await db.put(`idx:${DOMAIN}:posts:name:new-post:p2`, '');
  // 旧 tombstone p3（ts=50，同时代一并清理）
  await db.put(metaKey(DOMAIN, 'posts', 'p3'), JSON.stringify({ vv: { a: 3 }, ts: 50, tombstone: true }));
  // 另一集合的旧文档 c1（域级清理时也受影响，集合过滤时不受影响）
  await db.put(`doc:${DOMAIN}:comments:c1`, JSON.stringify({ name: 'old-comment' }));
  await db.put(metaKey(DOMAIN, 'comments', 'c1'), JSON.stringify({ vv: { a: 1 }, ts: OLD_TS }));
}

describe('previewPurgeDomainDocs', () => {
  it('reports affected scope without deleting anything', async () => {
    const db = new MemoryDb();
    await seedDomain(db);

    const preview = await previewPurgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS });

    expect(preview.collections.sort()).toEqual(['comments', 'posts']);
    expect(preview.affectedDocs).toBe(3); // p1 + p3 tombstone + c1
    expect(preview.affectedBytes).toBeGreaterThan(0);
    expect(db.keys().length).toBe(9); // 未删任何数据
  });

  it('refuses non-plugin domains', async () => {
    const db = new MemoryDb();
    await expect(previewPurgeDomainDocs(db as any, { domain: 'system', beforeTs: BEFORE_TS })).rejects.toThrow('non-plugin domain');
    await expect(purgeDomainDocs(db as any, { domain: 'evidence', beforeTs: BEFORE_TS })).rejects.toThrow('non-plugin domain');
  });
});

describe('purgeDomainDocs', () => {
  it('removes doc/idx/meta (incl. same-era tombstone) older than beforeTs and keeps newer data', async () => {
    const db = new MemoryDb();
    await seedDomain(db);

    const result = await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS });

    expect(result.removedDocs).toBe(3);
    expect(result.collections.sort()).toEqual(['comments', 'posts']);
    expect(result.freedBytes).toBeGreaterThan(0);

    // 旧数据全清（doc + meta + idx + tombstone）
    expect(await db.get(`doc:${DOMAIN}:posts:p1`)).toBe(null);
    expect(await db.get(metaKey(DOMAIN, 'posts', 'p1'))).toBe(null);
    expect(await db.get(`idx:${DOMAIN}:posts:name:old-post:p1`)).toBe(null);
    expect(await db.get(metaKey(DOMAIN, 'posts', 'p3'))).toBe(null);
    expect(await db.get(`doc:${DOMAIN}:comments:c1`)).toBe(null);
    // 新数据完整保留
    expect(await db.get(`doc:${DOMAIN}:posts:p2`)).toBe(JSON.stringify({ name: 'new-post' }));
    expect(await db.get(metaKey(DOMAIN, 'posts', 'p2'))).not.toBe(null);
    expect(await db.get(`idx:${DOMAIN}:posts:name:new-post:p2`)).not.toBe(null);

    // 水位线抬升且只升不降
    const watermark = await getPurgeWatermark(db as any, DOMAIN, 'posts');
    expect(watermark?.purgedBefore).toBe(BEFORE_TS);
    expect(watermark?.removedDocs).toBe(2);
    await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: 300 });
    expect((await getPurgeWatermark(db as any, DOMAIN, 'posts'))?.purgedBefore).toBe(BEFORE_TS);

    // 审计日志已追加
    expect(db.keys().some((key) => key.startsWith('doc:system:purge-log:'))).toBe(true);
  });

  it('respects the collection filter', async () => {
    const db = new MemoryDb();
    await seedDomain(db);

    const result = await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS, collection: 'posts' });

    expect(result.removedDocs).toBe(2); // p1 + p3
    expect(await db.get(`doc:${DOMAIN}:comments:c1`)).not.toBe(null);
    expect(await getPurgeWatermark(db as any, DOMAIN, 'comments')).toBe(null);
  });

  it('never touches evidence, organization, p2p or existing system keys', async () => {
    const db = new MemoryDb();
    await seedDomain(db);
    const untouched = [
      ['doc:evidence:proof:000000000001', JSON.stringify({ seq: 1 })],
      ['doc:evidence:head', JSON.stringify({ seq: 1 })],
      ['doc:system:collection-schema:x', JSON.stringify({ declaredAt: 1 })],
      ['org:meta:org1', JSON.stringify({ createdAt: 1 })],
      ['p2p:peer:record:peerA', JSON.stringify({ lastSeenAt: 1 })]
    ] as const;
    for (const [key, value] of untouched) {
      await db.put(key, value);
    }

    await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS });

    for (const [key, value] of untouched) {
      expect(await db.get(key)).toBe(value);
    }
  });

  it('blocks re-pushed purged docs via applyRemoteUpdate while accepting fresh writes', async () => {
    const db = new MemoryDb();
    await seedDomain(db);
    await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS });

    const collection = createCollectionStub(DOMAIN, 'posts');
    // 远端重推被清理的旧文档（原始 ts=100 < 水位线 500）→ 拒绝回灌
    await applyRemoteUpdate(db as any, collection, DOMAIN, 'posts', 'p1', { name: 'old-post' }, { vv: { a: 1 }, ts: OLD_TS, nodeId: 'remote' });
    expect(await db.get(`doc:${DOMAIN}:posts:p1`)).toBe(null);
    // 远端重推同时代 delete → 同样拒绝
    await applyRemoteUpdate(db as any, collection, DOMAIN, 'posts', 'px', null, { vv: { a: 9 }, ts: 200, nodeId: 'remote' });
    expect(await db.get(metaKey(DOMAIN, 'posts', 'px'))).toBe(null);
    // 晚于水位线的新写入 → 正常落地
    await applyRemoteUpdate(db as any, collection, DOMAIN, 'posts', 'p9', { name: 'fresh' }, { vv: { a: 4 }, ts: 600, nodeId: 'remote' });
    expect(await db.get(`doc:${DOMAIN}:posts:p9`)).toBe(JSON.stringify({ name: 'fresh' }));
  });

  it('is a no-op without writing a watermark when nothing matches', async () => {
    const db = new MemoryDb();
    await db.put(metaKey(DOMAIN, 'posts', 'p2'), JSON.stringify({ vv: { a: 2 }, ts: NEW_TS }));

    const result = await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS });

    expect(result.removedDocs).toBe(0);
    expect(await getPurgeWatermark(db as any, DOMAIN, 'posts')).toBe(null);
    expect(db.keys().some((key) => key.startsWith('doc:system:purge-log:'))).toBe(false);
  });

  it('purges docs with non-ASCII ids that a \\xFF upper bound would silently miss', async () => {
    const db = new MemoryDb();
    await db.put(`doc:${DOMAIN}:posts:文档一`, JSON.stringify({ name: 'old-cn-post' }));
    await db.put(metaKey(DOMAIN, 'posts', '文档一'), JSON.stringify({ vv: { a: 1 }, ts: OLD_TS }));
    await db.put(`idx:${DOMAIN}:posts:name:old-cn-post:文档一`, '');

    const result = await purgeDomainDocs(db as any, { domain: DOMAIN, beforeTs: BEFORE_TS });

    expect(result.removedDocs).toBe(1);
    expect(await db.get(`doc:${DOMAIN}:posts:文档一`)).toBe(null);
    expect(await db.get(metaKey(DOMAIN, 'posts', '文档一'))).toBe(null);
    expect(await db.get(`idx:${DOMAIN}:posts:name:old-cn-post:文档一`)).toBe(null);
    expect((await getPurgeWatermark(db as any, DOMAIN, 'posts'))?.purgedBefore).toBe(BEFORE_TS);
  });
});
