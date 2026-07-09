import { describe, expect, it, beforeEach } from 'vitest';
import { compareVersionVectors, resolveConflictByLWW, applyRemoteUpdate, metaKey } from '../../../main/db/sync';

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

  it('applies remote put update when remote is newer', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('u1', { name: 'Alice' });
    await db.put(metaKey('plugin:test', 'users', 'u1'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'users', 'u1', { name: 'Bob' }, { vv: { local: 2 }, ts: 200, nodeId: 'remote-node' });

    expect(await db.get(collection.docKey('u1'))).toBe(JSON.stringify({ name: 'Bob' }));
  });

  it('applies remote delete when remote wins in concurrent conflict', async () => {
    const db = createMockDB();
    const collection = createCollectionStub();
    await collection.setDoc('u2', { name: 'Carol' });
    await db.put(collection.docKey('u2'), JSON.stringify({ name: 'Carol' }));
    await db.put(metaKey('plugin:test', 'users', 'u2'), JSON.stringify({ vv: { local: 1 }, ts: 100 }));

    await applyRemoteUpdate(db, collection, 'plugin:test', 'users', 'u2', null, { vv: { local: 1, remote: 1 }, ts: 200, nodeId: 'remote-node' });

    expect(await db.get(collection.docKey('u2'))).toBe(null);
    const tombstone = JSON.parse((await db.get(metaKey('plugin:test', 'users', 'u2')))!);
    expect(tombstone.tombstone).toBe(true);
  });
});
