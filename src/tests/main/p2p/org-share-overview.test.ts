import { describe, expect, it } from 'vitest';
import { OrgShareSyncService } from '../../../main/p2p/org-share-sync';

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

function createService(db: MemoryDb, rootId: string): OrgShareSyncService {
  return new OrgShareSyncService({
    db: db as any,
    identityContext: { getCurrentRootId: async () => rootId },
    runtimeImport: async () => ({}),
    getNode: () => null,
    connectPeer: async () => {},
    broadcast: async () => {},
    getTopicSubscribers: () => []
  });
}

describe('OrgShareSyncService.getOrgSyncOverview', () => {
  it('aggregates replica state across members (self always counts)', async () => {
    const db = new MemoryDb();
    const selfRootId = 'a'.repeat(64);
    const syncedRootId = 'b'.repeat(64);
    const pendingRootId = 'c'.repeat(64);
    const orgId = 'org_overview_case';

    await db.put(`org:meta:${orgId}`, JSON.stringify({
      orgId,
      name: 'Overview Org',
      description: '',
      createdAt: 1,
      createdBy: selfRootId,
      updatedAt: 2,
      members: [
        { rootId: selfRootId, role: 'admin', joinedAt: 1, addedBy: selfRootId },
        { rootId: syncedRootId, role: 'member', joinedAt: 1, addedBy: selfRootId, nodeInfo: { peerId: 'QmSynced', addresses: [] } },
        { rootId: pendingRootId, role: 'member', joinedAt: 1, addedBy: selfRootId }
      ]
    }));
    await db.put(`p2p:org-sync-state:QmSynced:${orgId}`, JSON.stringify({
      versions: { summaryVersion: 2, membersVersion: 2, memberDetailsVersion: 2, transactionsVersion: 2 },
      lastSyncedAt: 123456
    }));

    const service = createService(db, selfRootId);
    const overview = await service.getOrgSyncOverview(orgId);

    expect(overview).not.toBeNull();
    expect(overview!.replicaTarget).toBe(3);
    expect(overview!.totalMembers).toBe(3);
    expect(overview!.syncedPeers).toBe(2);

    const self = overview!.members.find((member) => member.rootId === selfRootId);
    expect(self?.isSelf).toBe(true);
    expect(self?.everSynced).toBe(true);

    const synced = overview!.members.find((member) => member.rootId === syncedRootId);
    expect(synced?.everSynced).toBe(true);
    expect(synced?.lastSyncedAt).toBe(123456);

    const pending = overview!.members.find((member) => member.rootId === pendingRootId);
    expect(pending?.everSynced).toBe(false);
    expect(pending?.lastSyncedAt).toBeNull();
  });

  it('returns null for unknown organizations', async () => {
    const db = new MemoryDb();
    const service = createService(db, 'a'.repeat(64));
    expect(await service.getOrgSyncOverview('org_missing')).toBeNull();
  });

  it('excludes ancient lagging replicas but keeps recent or up-to-date ones', async () => {
    const db = new MemoryDb();
    const selfRootId = 'a'.repeat(64);
    const ancientLaggingRootId = 'b'.repeat(64);
    const recentLaggingRootId = 'c'.repeat(64);
    const ancientFreshRootId = 'd'.repeat(64);
    const orgId = 'org_fresh_case';
    const now = Date.now();
    const ancient = now - 40 * 24 * 60 * 60 * 1000;

    await db.put(`org:meta:${orgId}`, JSON.stringify({
      orgId,
      name: 'Fresh Org',
      description: '',
      createdAt: 1,
      createdBy: selfRootId,
      updatedAt: 1000,
      members: [
        { rootId: selfRootId, role: 'admin', joinedAt: 1, addedBy: selfRootId },
        { rootId: ancientLaggingRootId, role: 'member', joinedAt: 1, addedBy: selfRootId, nodeInfo: { peerId: 'QmAncientLag', addresses: [] } },
        { rootId: recentLaggingRootId, role: 'member', joinedAt: 1, addedBy: selfRootId, nodeInfo: { peerId: 'QmRecentLag', addresses: [] } },
        { rootId: ancientFreshRootId, role: 'member', joinedAt: 1, addedBy: selfRootId, nodeInfo: { peerId: 'QmAncientFresh', addresses: [] } }
      ],
      sync: {
        versions: { summaryVersion: 1000, membersVersion: 1000, memberDetailsVersion: 1000, transactionsVersion: 1000 },
        sections: ['summary', 'members', 'member-details', 'transactions'],
        lastSyncedAt: 0
      }
    }));

    const lagging = { summaryVersion: 10, membersVersion: 10, memberDetailsVersion: 10, transactionsVersion: 10 };
    const covering = { summaryVersion: 1000, membersVersion: 1000, memberDetailsVersion: 1000, transactionsVersion: 1000 };
    // 历史触达：很久前同步过且版本已落后 -> 不计入副本
    await db.put(`p2p:org-sync-state:QmAncientLag:${orgId}`, JSON.stringify({ versions: lagging, lastSyncedAt: ancient }));
    // 最近同步过但版本落后（在线追赶中）-> 计入副本
    await db.put(`p2p:org-sync-state:QmRecentLag:${orgId}`, JSON.stringify({ versions: lagging, lastSyncedAt: now }));
    // 很久前同步但版本仍覆盖当前（静默组织的健康副本）-> 计入副本
    await db.put(`p2p:org-sync-state:QmAncientFresh:${orgId}`, JSON.stringify({ versions: covering, lastSyncedAt: ancient }));

    const service = createService(db, selfRootId);
    const overview = await service.getOrgSyncOverview(orgId);

    expect(overview).not.toBeNull();
    expect(overview!.totalMembers).toBe(4);
    expect(overview!.syncedPeers).toBe(3);

    const byRoot = new Map(overview!.members.map((member) => [member.rootId, member]));
    expect(byRoot.get(ancientLaggingRootId)?.everSynced).toBe(false);
    expect(byRoot.get(recentLaggingRootId)?.everSynced).toBe(true);
    expect(byRoot.get(ancientFreshRootId)?.everSynced).toBe(true);
  });
});
