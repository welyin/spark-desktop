import { describe, expect, it, vi } from 'vitest';
import { createPubsubMessageHandler } from '../../../main/p2p/pubsub-message-handler';
import { DocumentCollection } from '../../../main/db/collection';
import { applyRemoteUpdate } from '../../../main/db/sync';
import { collectionSchemaKey } from '../../../main/db/schema';

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

function createHandler(db: MemoryDb, verifySignature: (envelope: any, pubKey: string, signature: string) => boolean) {
  const applyUpdate = vi.fn(
    async (domain: string, collection: string, id: string, payload: any, meta: any, schema?: any) => {
      const col = new DocumentCollection(db as any, domain, collection, {});
      await applyRemoteUpdate(db as any, col, domain, collection, id, payload, meta, { schema });
    }
  );
  const handler = createPubsubMessageHandler({
    db: db as any,
    verifySignature,
    orgShare: {
      applyIncomingOrgShare: vi.fn().mockResolvedValue({ accepted: false }),
      markAck: vi.fn()
    } as any,
    broadcast: vi.fn().mockResolvedValue(undefined),
    applyUpdate
  });
  return { handler, applyUpdate };
}

function dataMessage(body: Record<string, unknown>) {
  return { data: Buffer.from(JSON.stringify(body)) };
}

const DOC_KEY = 'doc:plugin:test:users:u1';
const SCHEMA_KEY = collectionSchemaKey('plugin:test', 'users');

describe('pubsub message handler signature enforcement', () => {
  it('drops unsigned data messages and never lets them touch storage or schema registry', async () => {
    const db = new MemoryDb();
    const { handler, applyUpdate } = createHandler(db, () => true);

    await handler(
      dataMessage({
        type: 'update',
        domain: 'plugin:test',
        collection: 'users',
        id: 'u1',
        payload: { name: 'Mallory' },
        meta: { vv: { remote: 1 }, ts: 100 },
        schema: { syncStrategy: 'lww' },
        timestamp: Date.now()
      })
    );

    expect(applyUpdate).not.toHaveBeenCalled();
    expect(await db.get(DOC_KEY)).toBe(null);
    expect(await db.get(SCHEMA_KEY)).toBe(null);
  });

  it('drops data messages with invalid signatures', async () => {
    const db = new MemoryDb();
    const { handler, applyUpdate } = createHandler(db, () => false);

    await handler(
      dataMessage({
        type: 'update',
        domain: 'plugin:test',
        collection: 'users',
        id: 'u1',
        payload: { name: 'Mallory' },
        meta: { vv: { remote: 1 }, ts: 100 },
        schema: { syncStrategy: 'lww' },
        timestamp: Date.now(),
        pubKey: 'fake-pub',
        signature: 'fake-sig'
      })
    );

    expect(applyUpdate).not.toHaveBeenCalled();
    expect(await db.get(DOC_KEY)).toBe(null);
    expect(await db.get(SCHEMA_KEY)).toBe(null);
  });

  it('applies signed data messages but still keeps the schema registry local-only', async () => {
    const db = new MemoryDb();
    const { handler, applyUpdate } = createHandler(db, () => true);

    await handler(
      dataMessage({
        type: 'update',
        domain: 'plugin:test',
        collection: 'users',
        id: 'u1',
        payload: { name: 'Alice' },
        meta: { vv: { remote: 1 }, ts: 100, nodeId: 'remote-node' },
        schema: { syncStrategy: 'lww' },
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig'
      })
    );

    // 已签名的消息正常应用（hint 仅瞬时生效）……
    expect(applyUpdate).toHaveBeenCalledWith('plugin:test', 'users', 'u1', { name: 'Alice' }, expect.anything(), {
      syncStrategy: 'lww'
    });
    expect(await db.get(DOC_KEY)).toBe(JSON.stringify({ name: 'Alice' }));
    // ……但消息携带的 schema 不得持久化到注册表（注册表只接受本地声明）
    expect(await db.get(SCHEMA_KEY)).toBe(null);
  });
});
