import { describe, expect, it } from 'vitest';
import { applyRemoteUpdate, metaKey } from '../../../main/db/sync';
import { getEvidenceHeight } from '../../../main/db/evidence';
import { getPurgeWatermark, isPurgedByWatermark, purgeWatermarkKey, raisePurgeWatermark } from '../../../main/data-management/watermark';
import { MemoryDb, createCollectionStub } from './helpers';

const DOMAIN = 'plugin:test';
const COLLECTION = 'posts';

describe('purge watermark', () => {
  it('returns null when unset and rises monotonically with accumulated removedDocs', async () => {
    const db = new MemoryDb();

    expect(await getPurgeWatermark(db as any, DOMAIN, COLLECTION)).toBe(null);

    const first = await raisePurgeWatermark(db as any, DOMAIN, COLLECTION, 500, 3);
    expect(first.purgedBefore).toBe(500);
    expect(first.removedDocs).toBe(3);

    // 只升不降：更早的点位不生效，数量累计
    const second = await raisePurgeWatermark(db as any, DOMAIN, COLLECTION, 300, 2);
    expect(second.purgedBefore).toBe(500);
    expect(second.removedDocs).toBe(5);

    const third = await raisePurgeWatermark(db as any, DOMAIN, COLLECTION, 900, 1);
    expect(third.purgedBefore).toBe(900);
    expect(third.removedDocs).toBe(6);

    // 键落在系统域，插件经底层 db 接口无法篡改
    expect(purgeWatermarkKey(DOMAIN, COLLECTION).startsWith('doc:system:purge-watermark:')).toBe(true);
  });

  it('judges timestamps against the watermark', async () => {
    const db = new MemoryDb();
    await raisePurgeWatermark(db as any, DOMAIN, COLLECTION, 500, 1);

    expect(await isPurgedByWatermark(db as any, DOMAIN, COLLECTION, 499)).toBe(true);
    expect(await isPurgedByWatermark(db as any, DOMAIN, COLLECTION, 500)).toBe(false);
    expect(await isPurgedByWatermark(db as any, DOMAIN, COLLECTION, 501)).toBe(false);
    expect(await isPurgedByWatermark(db as any, 'plugin:other', COLLECTION, 499)).toBe(false);
    expect(await isPurgedByWatermark(db as any, DOMAIN, COLLECTION, 0)).toBe(false);
  });
});

describe('applyRemoteUpdate watermark interception', () => {
  it('skips append-only remote put/delete older than the watermark without writing doc/meta/evidence', async () => {
    const db = new MemoryDb();
    const collection = createCollectionStub(DOMAIN, COLLECTION);
    await raisePurgeWatermark(db as any, DOMAIN, COLLECTION, 500, 1);

    // 同时代重推（ts < 水位线）：put 与 delete 都被拦截
    await applyRemoteUpdate(db as any, collection, DOMAIN, COLLECTION, 'p1', { name: 'old' }, { vv: { remote: 1 }, ts: 400, nodeId: 'remote' });
    await applyRemoteUpdate(db as any, collection, DOMAIN, COLLECTION, 'p2', null, { vv: { remote: 2 }, ts: 450, nodeId: 'remote' });

    expect(await db.get(collection.docKey('p1'))).toBe(null);
    expect(await db.get(metaKey(DOMAIN, COLLECTION, 'p1'))).toBe(null);
    expect(await db.get(metaKey(DOMAIN, COLLECTION, 'p2'))).toBe(null);
    // 存证链没有因为被拦截的写入而追加
    expect(await getEvidenceHeight(db as any)).toBe(0);

    // 晚于水位线的新写入正常落地（默认策略 append-only + 存证）
    await applyRemoteUpdate(db as any, collection, DOMAIN, COLLECTION, 'p3', { name: 'new' }, { vv: { remote: 3 }, ts: 600, nodeId: 'remote' });
    expect(await db.get(collection.docKey('p3'))).toBe(JSON.stringify({ name: 'new' }));
    expect(await db.get(metaKey(DOMAIN, COLLECTION, 'p3'))).not.toBe(null);
    expect(await getEvidenceHeight(db as any)).toBe(1);
  });

  it('skips lww remote put/delete older than the watermark', async () => {
    const db = new MemoryDb();
    const collection = createCollectionStub(DOMAIN, 'drafts');
    await raisePurgeWatermark(db as any, DOMAIN, 'drafts', 500, 1);

    // 本地无任何记录（清理后的状态），远端重推同时代 put/delete（ts < 水位线）
    await applyRemoteUpdate(db as any, collection, DOMAIN, 'drafts', 'd1', { name: 'old-draft' }, { vv: { remote: 5 }, ts: 100, nodeId: 'remote' }, { schema: { syncStrategy: 'lww' } });
    await applyRemoteUpdate(db as any, collection, DOMAIN, 'drafts', 'd2', null, { vv: { remote: 6 }, ts: 200, nodeId: 'remote' }, { schema: { syncStrategy: 'lww' } });

    expect(await db.get(collection.docKey('d1'))).toBe(null);
    expect(await db.get(metaKey(DOMAIN, 'drafts', 'd1'))).toBe(null);
    expect(await db.get(metaKey(DOMAIN, 'drafts', 'd2'))).toBe(null);

    // 晚于水位线的正常落地（remote 胜出分支）
    await applyRemoteUpdate(db as any, collection, DOMAIN, 'drafts', 'd1', { name: 'fresh-draft' }, { vv: { remote: 7 }, ts: 800, nodeId: 'remote' }, { schema: { syncStrategy: 'lww' } });
    expect(await db.get(collection.docKey('d1'))).toBe(JSON.stringify({ name: 'fresh-draft' }));
  });
});
