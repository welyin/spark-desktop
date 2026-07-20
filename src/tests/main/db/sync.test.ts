import { describe, expect, it, beforeEach } from 'vitest';
import { compareVersionVectors, resolveConflictByLWW, applyRemoteUpdate, metaKey } from '../../../main/db/sync';
import { getEvidenceEntry, getEvidenceHeight } from '../../../main/db/evidence';
import { getCollectionSchema } from '../../../main/db/schema';

function createMockDB() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async batch(ops: Array<{ type: 'put' | 'del'; key: string; value?: string }>) {
      for (const op of ops) {
        if (op.type === 'put') {
          store.set(op.key, op.value ?? '');
        } else {
          store.delete(op.key);
        }
      }
    },
    state: store
  } as any;
}

function createCollectionStub() {
  const docs = new Map<string, any>();
  return {
    async get(id: string) {
      return docs.has(id) ? docs.get(id) : null;
    },
    async setDoc(id: string, doc: any) {
      docs.set(id, doc);
    },
    docKey(id: string) {
      return `doc:plugin:test:users:${id}`;
    },
    indexKey(field: string, value: string, id: string) {
      return `idx:plugin:test:users:${field}:${value}:${id}`;
    },
    buildIndexMap(doc: any) {
      const map = new Map<string, string>();
      if (!doc) return map;
      if (doc.name) map.set('name', String(doc.name));
      return map;
    }
  } as any;
}

describe('sync helpers', () => {
  it('compares version vectors correctly', () => {
    expect(compareVersionVectors({ a: 1 }, { a: 1 })).toBe('equal');
    expect(compareVersionVectors({ a: 2 }, { a: 1 })).toBe('local');
    expect(compareVersionVectors({ a: 1 }, { a: 2 })).toBe('remote');
    expect(compareVersionVectors({ a: 1 }, { b: 1 })).toBe('concurrent');
  });

  it('resolves concurrent updates by LWW timestamp', () => {
    expect(resolveConflictByLWW(100, 200)).toBe('remote');
    expect(resolveConflictByLWW(300, 200)).toBe('local');
    expect(resolveConflictByLWW(100, 100)).toBe('equal');
  });

  it('applies remote put update when remote is newer (declared lww)', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('u1', { name: 'Alice' });
    await db.put(metaKey('plugin:test', 'users', 'u1'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'users', 'u1', { name: 'Bob' }, { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' }, { schema: { syncStrategy: 'lww' } });

    expect(await db.get(collection.docKey('u1'))).toBe(JSON.stringify({ name: 'Bob' }));
  });

  it('applies remote delete when remote wins in concurrent conflict (declared lww)', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('u2', { name: 'Carol' });
    await db.put(collection.docKey('u2'), JSON.stringify({ name: 'Carol' }));
    await db.put(metaKey('plugin:test', 'users', 'u2'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'users', 'u2', null, { vv: { local: 1, remote: 1 }, ts: 200, nodeId: 'remote-node' }, { schema: { syncStrategy: 'lww' } });

    expect(await db.get(collection.docKey('u2'))).toBe(null);
    const tombstone = JSON.parse((await db.get(metaKey('plugin:test', 'users', 'u2')))!);
    expect(tombstone.tombstone).toBe(true);
  });

  it('append-only (default): accepts remote put for a new document', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();

    await applyRemoteUpdate(db, collection, 'plugin:test', 'votes', 'v1', { choice: 'yes' }, { vv: { remote: 1 }, ts: 100, nodeId: 'remote-node' });

    expect(await db.get(collection.docKey('v1'))).toBe(JSON.stringify({ choice: 'yes' }));
    const meta = JSON.parse((await db.get(metaKey('plugin:test', 'votes', 'v1')))!);
    expect(meta.vv).toEqual({ remote: 1 });
  });

  it('append-only: dedupes identical remote payload and merges version vectors', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('v2', { choice: 'yes' });
    await db.put(collection.docKey('v2'), JSON.stringify({ choice: 'yes' }));
    await db.put(metaKey('plugin:test', 'votes', 'v2'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'votes', 'v2', { choice: 'yes' }, { vv: { remote: 1 }, ts: 150, nodeId: 'remote-node' });

    const meta = JSON.parse((await db.get(metaKey('plugin:test', 'votes', 'v2')))!);
    expect(meta.vv).toEqual({ local: 1, remote: 1 });
    expect(meta.ts).toBe(150);
  });

  it('append-only: rejects overwrite with conflicting payload and keeps local', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('v3', { choice: 'yes' });
    await db.put(collection.docKey('v3'), JSON.stringify({ choice: 'yes' }));
    await db.put(metaKey('plugin:test', 'votes', 'v3'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'votes', 'v3', { choice: 'no' }, { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' });

    expect(await db.get(collection.docKey('v3'))).toBe(JSON.stringify({ choice: 'yes' }));
    const meta = JSON.parse((await db.get(metaKey('plugin:test', 'votes', 'v3')))!);
    expect(meta.vv).toEqual({ local: 1 });
  });

  it('append-only: drops remote delete', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('v4', { choice: 'yes' });
    await db.put(collection.docKey('v4'), JSON.stringify({ choice: 'yes' }));
    await db.put(metaKey('plugin:test', 'votes', 'v4'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'votes', 'v4', null, { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' });

    expect(await db.get(collection.docKey('v4'))).toBe(JSON.stringify({ choice: 'yes' }));
  });

  it('never persists remote schema hints (policy registry is local-only)', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();

    await applyRemoteUpdate(db, collection, 'plugin:test', 'users', 'n1', { name: 'N' }, { vv: { remote: 1 }, ts: 100, nodeId: 'remote-node' }, { schema: { syncStrategy: 'lww' } });

    // hint 仅作本次应用的兜底策略，不写入注册表
    expect(await getCollectionSchema(db, 'plugin:test', 'users')).toBe(null);
  });

  it('ignores invalid remote schema hints and falls back to the safest default', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('u9', { name: 'Alice' });
    await db.put(collection.docKey('u9'), JSON.stringify({ name: 'Alice' }));
    await db.put(metaKey('plugin:test', 'users', 'u9'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    // 非法 hint（governance 配 lww）被忽略，按默认 append-only 处理：拒绝覆盖
    await applyRemoteUpdate(
      db,
      collection,
      'plugin:test',
      'users',
      'u9',
      { name: 'Mallory' },
      { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' },
      { schema: { syncStrategy: 'lww', governance: true } }
    );

    expect(await db.get(collection.docKey('u9'))).toBe(JSON.stringify({ name: 'Alice' }));
  });

  it('lww + enableEvidence: appends evidence when a remote put wins by version vector', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('a1', { name: 'Alice' });
    await db.put(collection.docKey('a1'), JSON.stringify({ name: 'Alice' }));
    await db.put(metaKey('plugin:test', 'audited', 'a1'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(
      db,
      collection,
      'plugin:test',
      'audited',
      'a1',
      { name: 'Bob' },
      { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' },
      { schema: { syncStrategy: 'lww', enableEvidence: true } }
    );

    expect(await db.get(collection.docKey('a1'))).toBe(JSON.stringify({ name: 'Bob' }));
    expect(await getEvidenceHeight(db)).toBe(1);
    const entry = await getEvidenceEntry(db, 1);
    expect(entry).toMatchObject({ collection: 'audited', id: 'a1', op: 'put' });
  });

  it('lww + enableEvidence: appends evidence when a remote delete wins by version vector', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('a2', { name: 'Carol' });
    await db.put(collection.docKey('a2'), JSON.stringify({ name: 'Carol' }));
    await db.put(metaKey('plugin:test', 'audited', 'a2'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(
      db,
      collection,
      'plugin:test',
      'audited',
      'a2',
      null,
      { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' },
      { schema: { syncStrategy: 'lww', enableEvidence: true } }
    );

    expect(await db.get(collection.docKey('a2'))).toBe(null);
    expect(await getEvidenceHeight(db)).toBe(1);
    const entry = await getEvidenceEntry(db, 1);
    expect(entry).toMatchObject({ collection: 'audited', id: 'a2', op: 'delete' });
  });
});
