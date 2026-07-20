import { describe, expect, it } from 'vitest';
import { DocumentCollection } from '../../../main/db/collection';
import { declareCollectionSchema, collectionSchemaKey } from '../../../main/db/schema';

class MemoryDb {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async batch(operations: Array<{ type: 'put' | 'del'; key: string; value?: string }>): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        this.store.set(op.key, op.value ?? '');
      } else {
        this.store.delete(op.key);
      }
    }
  }

  async queryRange(options: { prefix: string; start?: string; end?: string }): Promise<Array<{ key: string; value: string }>> {
    return [...this.store.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
  }
}

describe('DocumentCollection sync strategy enforcement', () => {
  it('append-only (declared): rejects overwrite and delete, keeps the first write', async () => {
    const db = new MemoryDb() as any;
    await declareCollectionSchema(db, 'plugin:test', 'votes', { syncStrategy: 'append-only' });
    const coll = new DocumentCollection(db, 'plugin:test', 'votes', {});

    await coll.put('v1', { choice: 'yes' });
    await expect(coll.put('v1', { choice: 'no' })).rejects.toThrow(/append-only/);
    await expect(coll.delete('v1')).rejects.toThrow(/append-only/);

    expect(await coll.get('v1')).toEqual({ choice: 'yes' });
  });

  it('append-only: forces chained evidence even when not explicitly enabled', async () => {
    const db = new MemoryDb() as any;
    await declareCollectionSchema(db, 'plugin:test', 'votes', { syncStrategy: 'append-only' });
    const coll = new DocumentCollection(db, 'plugin:test', 'votes', {});

    await coll.put('v1', { choice: 'yes' });

    const head = await db.get('doc:evidence:head');
    expect(head).toBeTruthy();
    expect(JSON.parse(head!).seq).toBe(1);
  });

  it('lww (declared): allows overwrite and delete', async () => {
    const db = new MemoryDb() as any;
    await declareCollectionSchema(db, 'plugin:test', 'drafts', { syncStrategy: 'lww' });
    const coll = new DocumentCollection(db, 'plugin:test', 'drafts', {});

    await coll.put('d1', { text: 'v1' });
    await coll.put('d1', { text: 'v2' });
    expect(await coll.get('d1')).toEqual({ text: 'v2' });

    await coll.delete('d1');
    expect(await coll.get('d1')).toBe(null);
  });

  it('governance declaration forces append-only regardless of constructor config', async () => {
    const db = new MemoryDb() as any;
    await declareCollectionSchema(db, 'plugin:test', 'ledger', { syncStrategy: 'append-only', governance: true });
    // 构造配置试图声明 lww，持久化治理声明优先
    const coll = new DocumentCollection(db, 'plugin:test', 'ledger', { syncStrategy: 'lww' });

    await coll.put('entry1', { amount: 100 });
    await expect(coll.put('entry1', { amount: 200 })).rejects.toThrow(/append-only/);
  });

  it('defaults undeclared collections to append-only (safest)', async () => {
    const db = new MemoryDb() as any;
    const coll = new DocumentCollection(db, 'plugin:test', 'undeclared', {});

    await coll.put('x1', { v: 1 });
    await expect(coll.put('x1', { v: 2 })).rejects.toThrow(/append-only/);
    expect(await db.get(collectionSchemaKey('plugin:test', 'undeclared'))).toBe(null);
  });

  it('legacy config-only hint keeps overwrite semantics without a persisted declaration', async () => {
    const db = new MemoryDb() as any;
    const coll = new DocumentCollection(db, 'plugin:test', 'legacy', { enableEvidence: true });

    await coll.put('x1', { v: 1 });
    await coll.put('x1', { v: 2 });
    expect(await coll.get('x1')).toEqual({ v: 2 });
  });

  it('enforces append-only inside transactions as well', async () => {
    const db = new MemoryDb() as any;
    await declareCollectionSchema(db, 'plugin:test', 'votes', { syncStrategy: 'append-only' });
    const coll = new DocumentCollection(db, 'plugin:test', 'votes', {});

    await coll.put('v1', { choice: 'yes' });
    await expect(
      coll.transaction(async (tx) => {
        await tx.put('v1', { choice: 'no' });
      })
    ).rejects.toThrow(/append-only/);
    await expect(
      coll.transaction(async (tx) => {
        await tx.delete('v1');
      })
    ).rejects.toThrow(/append-only/);
  });
});
