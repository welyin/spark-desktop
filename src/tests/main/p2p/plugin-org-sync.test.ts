import { describe, expect, it } from 'vitest';
import { applyPluginDocSyncItems, collectSyncablePluginDocsByOrg } from '../../../main/p2p/plugin-org-sync';

class MemoryDb {
  private readonly store = new Map<string, string>();

  async open(): Promise<void> {}

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

describe('plugin org sync', () => {
  it('collects org plugin docs by default and excludes explicit opt-out docs', async () => {
    const db = new MemoryDb() as any;
    await db.put('doc:plugin:weibo-core:posts:post_1', JSON.stringify({ id: 'post_1', orgId: 'org_A', content: 'hello' }));
    await db.put('meta:plugin:weibo-core:posts:post_1', JSON.stringify({ vv: { n1: 1 }, ts: 10, nodeId: 'n1' }));

    await db.put('doc:plugin:weibo-core:posts:post_2', JSON.stringify({
      id: 'post_2',
      orgId: 'org_A',
      content: 'local only',
      __sync: { disabled: true }
    }));
    await db.put('meta:plugin:weibo-core:posts:post_2', JSON.stringify({ vv: { n1: 2 }, ts: 20, nodeId: 'n1' }));

    await db.put('doc:plugin:weibo-core:posts:post_3', JSON.stringify({ id: 'post_3', orgId: 'org_B', content: 'other org' }));
    await db.put('meta:plugin:weibo-core:posts:post_3', JSON.stringify({ vv: { n1: 3 }, ts: 30, nodeId: 'n1' }));

    const items = await collectSyncablePluginDocsByOrg(db, 'org_A');

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('post_1');
  });

  it('applies incoming plugin doc sync items', async () => {
    const db = new MemoryDb() as any;
    const items = [
      {
        domain: 'plugin:weibo-core',
        collection: 'posts',
        id: 'post_remote_1',
        payload: {
          id: 'post_remote_1',
          orgId: 'org_A',
          content: 'synced'
        },
        meta: {
          vv: { remote: 1 },
          ts: 100,
          nodeId: 'remote'
        }
      }
    ];

    const applied = await applyPluginDocSyncItems(db, items);

    expect(applied).toBe(1);
    const stored = await db.get('doc:plugin:weibo-core:posts:post_remote_1');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toMatchObject({ orgId: 'org_A', content: 'synced' });
  });
});
