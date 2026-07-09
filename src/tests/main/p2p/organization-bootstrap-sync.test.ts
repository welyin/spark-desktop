import { describe, expect, it } from 'vitest';
import { syncCurrentRootOrganizationsToPeer } from '../../../main/p2p/organization-bootstrap-sync';
import type { OrganizationRecord } from '../../../main/organization';
import type { PeerNodeInfo } from '../../../main/p2p/types';

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

function makeOrg(orgId: string, rootId: string, updatedAt: number): OrganizationRecord {
  return {
    orgId,
    name: `Org-${orgId}`,
    description: '',
    createdAt: updatedAt - 10,
    createdBy: rootId,
    updatedAt,
    members: [
      {
        rootId,
        role: 'admin',
        joinedAt: updatedAt - 10,
        addedBy: rootId,
        nodeInfo: {
          peerId: 'QmOwner',
          addresses: ['/ip4/127.0.0.1/tcp/13000/ws']
        }
      }
    ]
  };
}

describe('syncCurrentRootOrganizationsToPeer', () => {
  it('continues syncing remaining organizations even if one push fails', async () => {
    const db = new MemoryDb() as any;
    const currentRootId = 'a'.repeat(64);
    const targetPeer: PeerNodeInfo = {
      peerId: 'QmTarget',
      addresses: ['/ip4/127.0.0.1/tcp/14000/ws']
    };

    const orgA = makeOrg('org_A', currentRootId, 1000);
    const orgB = makeOrg('org_B', currentRootId, 1100);
    const orgC = makeOrg('org_C', currentRootId, 1200);

    await db.put(`org:meta:${orgA.orgId}`, JSON.stringify(orgA));
    await db.put(`org:meta:${orgB.orgId}`, JSON.stringify(orgB));
    await db.put(`org:meta:${orgC.orgId}`, JSON.stringify(orgC));

    const attempts: string[] = [];
    const result = await syncCurrentRootOrganizationsToPeer({
      db,
      currentRootId,
      targetPeer,
      syncOrganizationToMember: async (_nodeInfo, _targetRootId, organization) => {
        attempts.push(organization.orgId);
        if (organization.orgId === 'org_B') {
          throw new Error('network timeout');
        }
      }
    });

    expect(result.attempted).toBe(3);
    expect(result.synced).toBe(2);
    expect(attempts).toHaveLength(3);
  });
});
