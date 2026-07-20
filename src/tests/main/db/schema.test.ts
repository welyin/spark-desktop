import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECTION_POLICY,
  collectionSchemaKey,
  declareCollectionSchema,
  getCollectionSchema,
  resolveCollectionPolicy,
  resolveSchemaDeclaration
} from '../../../main/db/schema';

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

describe('collection schema registry', () => {
  it('persists declarations and resolves them back', async () => {
    const db = createMockDB();
    await declareCollectionSchema(db, 'plugin:test', 'drafts', { syncStrategy: 'lww' });

    const record = await getCollectionSchema(db, 'plugin:test', 'drafts');
    expect(record).toMatchObject({ syncStrategy: 'lww', governance: false, enableEvidence: false });

    const policy = await resolveCollectionPolicy(db, 'plugin:test', 'drafts');
    expect(policy.syncStrategy).toBe('lww');
    expect(policy.enableEvidence).toBe(false);
  });

  it('stores schema records in the system domain (plugin raw db access cannot reach them)', () => {
    const key = collectionSchemaKey('plugin:test', 'votes');
    expect(key.startsWith('doc:system:collection-schema:')).toBe(true);
    // id 部分不含未编码冒号，保证键仍符合 doc:{domain}:{collection}:{id} 三段式
    expect(key.split(':')).toHaveLength(4);
  });

  it('forces evidence for append-only collections', () => {
    const policy = resolveSchemaDeclaration({ syncStrategy: 'append-only', enableEvidence: false });
    expect(policy.enableEvidence).toBe(true);
  });

  it('forces append-only + evidence for governance collections and rejects downgrade', () => {
    expect(() => resolveSchemaDeclaration({ syncStrategy: 'lww', governance: true })).toThrow(/append-only/);

    const policy = resolveSchemaDeclaration({ syncStrategy: 'append-only', governance: true });
    expect(policy).toEqual({ syncStrategy: 'append-only', governance: true, enableEvidence: true });
  });

  it('rejects invalid declarations', async () => {
    const db = createMockDB();
    await expect(declareCollectionSchema(db, 'plugin:test', 'votes', {} as any)).rejects.toThrow(/syncStrategy/);
    await expect(declareCollectionSchema(db, 'plugin:test', 'bad:name', { syncStrategy: 'lww' })).rejects.toThrow(
      /Invalid collection name/
    );
  });

  it('is idempotent for identical re-declaration but rejects conflicting re-declaration', async () => {
    const db = createMockDB();
    const first = await declareCollectionSchema(db, 'plugin:test', 'votes', { syncStrategy: 'append-only' });
    const again = await declareCollectionSchema(db, 'plugin:test', 'votes', { syncStrategy: 'append-only' });
    expect(again.declaredAt).toBe(first.declaredAt);

    await expect(declareCollectionSchema(db, 'plugin:test', 'votes', { syncStrategy: 'lww' })).rejects.toThrow(
      /already declared/
    );
  });

  it('falls back to the safest default for undeclared collections', async () => {
    const db = createMockDB();
    const policy = await resolveCollectionPolicy(db, 'plugin:test', 'unknown');
    expect(policy).toEqual(DEFAULT_COLLECTION_POLICY);
    expect(policy.syncStrategy).toBe('append-only');
    expect(policy.enableEvidence).toBe(true);
  });
});
