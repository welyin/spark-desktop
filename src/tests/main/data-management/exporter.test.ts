import { mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildExportDump, writeExportDump } from '../../../main/data-management/exporter';
import { MemoryDb } from './helpers';

const workdir = mkdtempSync(path.join(tmpdir(), 'spark-export-test-'));

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('buildExportDump', () => {
  it('dumps every key including non-ASCII keys with a versioned envelope', async () => {
    const db = new MemoryDb();
    await db.put('doc:plugin:test:posts:p1', JSON.stringify({ name: 'a' }));
    await db.put('meta:plugin:test:posts:p1', JSON.stringify({ vv: { a: 1 }, ts: 1 }));
    await db.put('doc:plugin:test:posts:中文文档', JSON.stringify({ name: 'b' }));

    const dump = await buildExportDump(db as any);

    expect(dump.formatVersion).toBe(1);
    expect(dump.app).toBe('spark-desktop');
    expect(dump.exportedAt).toBeGreaterThan(0);
    expect(dump.entries).toHaveLength(3);
    const keys = dump.entries.map((entry) => entry.key);
    expect(keys).toContain('doc:plugin:test:posts:p1');
    expect(keys).toContain('doc:plugin:test:posts:中文文档');
    const p1 = dump.entries.find((entry) => entry.key === 'doc:plugin:test:posts:p1');
    expect(p1?.value).toBe(JSON.stringify({ name: 'a' }));
  });
});

describe('writeExportDump', () => {
  it('writes a round-trippable JSON file and reports stats', async () => {
    const db = new MemoryDb();
    await db.put('org:meta:org1', JSON.stringify({ name: 'org' }));
    await db.put('p2p:listen:wsPort', '15002');

    const filePath = path.join(workdir, 'export.json');
    const result = await writeExportDump(db as any, filePath);

    expect(result.path).toBe(filePath);
    expect(result.entries).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);

    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.find((entry: any) => entry.key === 'p2p:listen:wsPort')?.value).toBe('15002');
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(parsed), 'utf8'));
  });
});
