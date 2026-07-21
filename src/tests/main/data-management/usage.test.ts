import { describe, expect, it } from 'vitest';
import { classifyKey, collectDataUsage } from '../../../main/data-management/usage';
import { MemoryDb } from './helpers';

describe('classifyKey', () => {
  it('classifies by key prefix with more specific prefixes first', () => {
    expect(classifyKey('doc:evidence:proof:000000000001')).toBe('evidence');
    expect(classifyKey('doc:system:collection-schema:x')).toBe('system');
    expect(classifyKey('doc:plugin:test:posts:p1')).toBe('documents');
    expect(classifyKey('idx:plugin:test:posts:name:a:p1')).toBe('indexes');
    expect(classifyKey('meta:plugin:test:posts:p1')).toBe('syncMeta');
    expect(classifyKey('org:meta:org1')).toBe('organization');
    expect(classifyKey('org:tx:org1:1:tx1')).toBe('organization');
    expect(classifyKey('p2p:peer:record:peerA')).toBe('p2p');
    expect(classifyKey('something-else')).toBe('other');
  });
});

describe('collectDataUsage', () => {
  it('aggregates per-class key counts and byte sizes with totals', async () => {
    const db = new MemoryDb();
    await db.put('doc:plugin:test:posts:p1', JSON.stringify({ name: 'a' }));
    await db.put('doc:plugin:test:posts:p2', JSON.stringify({ name: 'b' }));
    await db.put('idx:plugin:test:posts:name:a:p1', '');
    await db.put('meta:plugin:test:posts:p1', JSON.stringify({ vv: { a: 1 }, ts: 1 }));
    await db.put('doc:evidence:proof:000000000001', JSON.stringify({ seq: 1 }));
    await db.put('doc:system:meta:initialized', 'true');
    await db.put('org:meta:org1', JSON.stringify({ name: 'org' }));
    await db.put('p2p:listen:wsPort', '15002');
    // 非 ASCII 键也要被统计到（遍历上限为最大 UTF-8 码位）
    await db.put('doc:plugin:test:posts:中文文档', JSON.stringify({ name: 'c' }));

    const report = await collectDataUsage(db as any);

    expect(report.classes.documents.keys).toBe(3);
    expect(report.classes.indexes.keys).toBe(1);
    expect(report.classes.syncMeta.keys).toBe(1);
    expect(report.classes.evidence.keys).toBe(1);
    expect(report.classes.system.keys).toBe(1);
    expect(report.classes.organization.keys).toBe(1);
    expect(report.classes.p2p.keys).toBe(1);
    expect(report.classes.other.keys).toBe(0);
    expect(report.totalKeys).toBe(9);
    const allRows = await db.queryRange({ prefix: '', end: '􏿿' });
    const expectedBytes = allRows.reduce((sum, row) => sum + Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8'), 0);
    expect(report.totalBytes).toBe(expectedBytes);
    expect(report.classes.documents.bytes).toBeGreaterThan(0);
    // 小数据量不触发软配额警告；未提供磁盘路径时 disk 为 null 且不告警
    expect(report.warnings.usageExceeded).toBe(false);
    expect(report.warnings.diskLow).toBe(false);
    expect(report.disk).toBe(null);
  });

  it('attaches disk info when statfs is supported and degrades gracefully otherwise', async () => {
    const db = new MemoryDb();

    // fs.statfs 需 Node >= 18.15：生产运行时 Electron 26（Node 18.16）可用；
    // 部分开发/CI 环境 Node 更旧时必须静默降级为 disk=null 而非报错
    const supported = typeof (await import('fs/promises')).statfs === 'function';
    const withDisk = await collectDataUsage(db as any, '/');
    if (supported) {
      expect(withDisk.disk).not.toBe(null);
      expect(withDisk.disk!.freeRatio).toBeGreaterThan(0);
      expect(withDisk.disk!.freeRatio).toBeLessThanOrEqual(1);
    } else {
      expect(withDisk.disk).toBe(null);
    }

    const withBadPath = await collectDataUsage(db as any, '/nonexistent-path-xyz-123');
    expect(withBadPath.disk).toBe(null);
  });
});
