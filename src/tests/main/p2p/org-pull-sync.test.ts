import { describe, expect, it } from 'vitest';
import { OrgPullSyncService } from '../../../main/p2p/org-pull-sync';

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

  async queryRange(options: { prefix: string; start?: string; end?: string }): Promise<Array<{ key: string; value: string }>> {
    return [...this.store.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
  }
}

describe('OrgPullSyncService', () => {
  it('removes local org when peer confirms member was removed', async () => {
    const db = new MemoryDb() as any;
    const rootId = 'a'.repeat(64);
    const orgId = 'org_removed_case';

    await db.put(`org:meta:${orgId}`, JSON.stringify({
      orgId,
      name: 'To Remove',
      description: '',
      createdAt: 1,
      createdBy: rootId,
      updatedAt: 2,
      members: [
        {
          rootId,
          role: 'member',
          joinedAt: 1,
          addedBy: rootId
        }
      ]
    }));

    let pushCalls = 0;
    const service = new OrgPullSyncService({
      db,
      identityContext: {
        getCurrentRootId: async () => rootId
      },
      runtimeImport: async () => ({}),
      getNode: () => ({ peerId: { toString: () => 'QmSelf' } }),
      connectPeer: async () => {},
      syncOrganizationToMember: async () => {
        pushCalls += 1;
      }
    });

    (service as any).requestDirect = async (_nodeInfo: any, request: any) => {
      if (request.type === 'org-pull-list') {
        return {
          ok: true,
          type: 'org-pull-list-response',
          organizations: []
        };
      }

      return {
        ok: true,
        type: 'org-pull-org-response',
        orgId,
        status: 'removed',
        reason: 'not-member'
      };
    };

    const result = await service.reconcileFromPeer({
      peerId: 'QmPeer',
      addresses: ['/ip4/127.0.0.1/tcp/15002/ws']
    });

    expect(result.removed).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.pushAttempted).toBe(0);
    expect(pushCalls).toBe(0);
    expect(await db.get(`org:meta:${orgId}`)).toBeNull();
  });
});
