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

  it('forwards piggybacked node info claims on list requests without breaking responses', async () => {
    const db = new MemoryDb() as any;
    const rootId = 'a'.repeat(64);
    const requesterRootId = 'b'.repeat(64);
    const claimCalls: Array<{ claim: unknown; context: unknown }> = [];

    // 请求方须是某组织成员，claim 才会被处理
    await db.put('org:meta:org_claim_case', JSON.stringify({
      orgId: 'org_claim_case',
      name: 'Claim Org',
      description: '',
      createdAt: 1,
      createdBy: rootId,
      updatedAt: 2,
      members: [
        { rootId, role: 'admin', joinedAt: 1, addedBy: rootId },
        { rootId: requesterRootId, role: 'member', joinedAt: 1, addedBy: rootId }
      ]
    }));

    const service = new OrgPullSyncService({
      db,
      identityContext: { getCurrentRootId: async () => rootId },
      runtimeImport: async () => ({}),
      getNode: () => null,
      connectPeer: async () => {},
      onNodeInfoClaim: async (claim, context) => {
        claimCalls.push({ claim, context });
      }
    });

    const response = await service.handleDirectRequest({
      type: 'org-pull-list',
      payload: {
        requesterRootId,
        requesterPeerId: 'QmRequester',
        nodeInfoClaim: { marker: 'claim' }
      }
    }, { connection: { remotePeer: 'QmRemote' } });

    expect(response.ok).toBe(true);
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]?.claim).toEqual({ marker: 'claim' });
    expect(claimCalls[0]?.context).toEqual({ remotePeerId: 'QmRemote' });

    // claim 处理失败不影响本次拉取响应
    const failing = new OrgPullSyncService({
      db,
      identityContext: { getCurrentRootId: async () => rootId },
      runtimeImport: async () => ({}),
      getNode: () => null,
      connectPeer: async () => {},
      onNodeInfoClaim: async () => {
        throw new Error('claim store down');
      }
    });
    const stillOk = await failing.handleDirectRequest({
      type: 'org-pull-list',
      payload: { requesterRootId, nodeInfoClaim: { marker: 'claim' } }
    }, {});
    expect(stillOk.ok).toBe(true);
  });

  it('does not process node info claims from non-member requesters', async () => {
    const db = new MemoryDb() as any;
    const rootId = 'a'.repeat(64);
    const claimCalls: unknown[] = [];

    await db.put('org:meta:org_claim_gate', JSON.stringify({
      orgId: 'org_claim_gate',
      name: 'Gated Org',
      description: '',
      createdAt: 1,
      createdBy: rootId,
      updatedAt: 2,
      members: [{ rootId, role: 'admin', joinedAt: 1, addedBy: rootId }]
    }));

    const service = new OrgPullSyncService({
      db,
      identityContext: { getCurrentRootId: async () => rootId },
      runtimeImport: async () => ({}),
      getNode: () => null,
      connectPeer: async () => {},
      onNodeInfoClaim: async (claim) => {
        claimCalls.push(claim);
      }
    });

    const response = await service.handleDirectRequest({
      type: 'org-pull-list',
      payload: {
        requesterRootId: 'c'.repeat(64),
        nodeInfoClaim: { marker: 'stranger-claim' }
      }
    }, { connection: { remotePeer: 'QmStranger' } });

    expect(response.ok).toBe(true);
    expect(claimCalls).toHaveLength(0);
  });

  it('records peer sync state after a successful pull', async () => {
    const db = new MemoryDb() as any;
    const rootId = 'a'.repeat(64);
    const orgId = 'org_sync_state_case';

    await db.put(`org:meta:${orgId}`, JSON.stringify({
      orgId,
      name: 'Local Copy',
      description: '',
      createdAt: 1,
      createdBy: rootId,
      updatedAt: 2,
      members: [{ rootId, role: 'member', joinedAt: 1, addedBy: rootId }]
    }));

    const syncStateCalls: Array<{ peerId: string; orgId: string; versions: any }> = [];
    const service = new OrgPullSyncService({
      db,
      identityContext: { getCurrentRootId: async () => rootId },
      runtimeImport: async () => ({}),
      getNode: () => ({ peerId: { toString: () => 'QmSelf' } }),
      connectPeer: async () => {},
      onSyncState: async (peerId, org, versions) => {
        syncStateCalls.push({ peerId, orgId: org, versions });
      }
    });

    const remoteVersions = { summaryVersion: 100, membersVersion: 100, memberDetailsVersion: 100, transactionsVersion: 100 };
    (service as any).requestDirect = async (_nodeInfo: any, request: any) => {
      if (request.type === 'org-pull-list') {
        return {
          ok: true,
          type: 'org-pull-list-response',
          organizations: [{ orgId, sync: remoteVersions }]
        };
      }
      return {
        ok: true,
        type: 'org-pull-org-response',
        orgId,
        status: 'member',
        organization: {
          orgId,
          name: 'Remote Copy',
          description: '',
          createdAt: 1,
          createdBy: rootId,
          updatedAt: 100,
          members: [{ rootId, role: 'member', joinedAt: 1, addedBy: rootId }]
        }
      };
    };

    const result = await service.reconcileFromPeer({
      peerId: 'QmPeer',
      addresses: ['/ip4/127.0.0.1/tcp/15002/ws']
    });

    expect(result.pulled).toBe(1);
    expect(syncStateCalls).toHaveLength(1);
    expect(syncStateCalls[0]?.peerId).toBe('QmPeer');
    expect(syncStateCalls[0]?.orgId).toBe(orgId);
    expect(syncStateCalls[0]?.versions.summaryVersion).toBe(100);
  });

  it('piggybacks nodeInfoClaim on the list request when extras provide one', async () => {
    const db = new MemoryDb() as any;
    const rootId = 'a'.repeat(64);

    const service = new OrgPullSyncService({
      db,
      identityContext: { getCurrentRootId: async () => rootId },
      runtimeImport: async () => ({}),
      getNode: () => ({ peerId: { toString: () => 'QmSelf' } }),
      connectPeer: async () => {}
    });

    const sentPayloads: any[] = [];
    (service as any).requestDirect = async (_nodeInfo: any, request: any) => {
      sentPayloads.push(request.payload);
      return {
        ok: true,
        type: 'org-pull-list-response',
        organizations: []
      };
    };

    // 周期性重宣告场景：调用方每次拉取都捎带一份新鲜签名的 claim，
    // 使对端能及时感知家用宽带公网 IPv4/IPv6 前缀变化
    const claim = { type: 'spark-node-info-claim', signature: 'sig', marker: 'reannounce' };
    await service.reconcileFromPeer(
      { peerId: 'QmPeer', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] },
      { nodeInfoClaim: claim }
    );

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.nodeInfoClaim).toEqual(claim);
    expect(sentPayloads[0]?.requesterRootId).toBe(rootId);
    expect(sentPayloads[0]?.requesterPeerId).toBe('QmSelf');

    // 未提供 claim 时 payload 不带该字段（undefined），保持原有报文形态
    sentPayloads.length = 0;
    await service.reconcileFromPeer({ peerId: 'QmPeer', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] });
    expect(sentPayloads[0]?.nodeInfoClaim).toBeUndefined();
  });
});
