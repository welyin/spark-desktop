import { describe, expect, it } from 'vitest';
import { OrganizationService } from '../../../main/organization';
import { RECOVERY_TIME_BUCKET_MS, RECOVERY_TRIGGER_CONSECUTIVE_TICKS } from '../../../main/p2p/constants';
import { activeRecoveryTokens, computeRecoveryToken, OrgRecoveryService } from '../../../main/p2p/org-recovery';
import { P2PNode } from '../../../main/p2p/p2p-node';

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

/** 构造 source/sink 假流：读侧给出请求文本，写侧捕获响应文本。 */
function makeFakeStream(requestText: string, capturedWrites: string[]) {
  return {
    source: (async function* () {
      yield Buffer.from(requestText, 'utf8');
    })(),
    sink: async (source: AsyncIterable<Uint8Array>) => {
      for await (const chunk of source) {
        capturedWrites.push(Buffer.from(chunk).toString('utf8'));
      }
    }
  };
}

const ORG_ID = 'org_recovery_case';
const SECRET = 'a1b2c3'.repeat(10) + 'a1b2';
const MEMBER_ROOT = 'm'.repeat(64);

function makeViewEntry(memberNodeInfos: Array<{ peerId?: string; addresses: string[] }> = []) {
  return { orgId: ORG_ID, recoverySecret: SECRET, memberNodeInfos };
}

describe('recovery token', () => {
  it('matches current and previous time buckets only', () => {
    const now = RECOVERY_TIME_BUCKET_MS * 100 + 1234;
    const bucket = Math.floor(now / RECOVERY_TIME_BUCKET_MS);
    const tokenCurrent = computeRecoveryToken(ORG_ID, SECRET, bucket);
    const tokenPrevious = computeRecoveryToken(ORG_ID, SECRET, bucket - 1);
    const tokenOlder = computeRecoveryToken(ORG_ID, SECRET, bucket - 2);

    const active = activeRecoveryTokens(ORG_ID, SECRET, now);
    expect(active).toContain(tokenCurrent);
    expect(active).toContain(tokenPrevious);
    expect(active).not.toContain(tokenOlder);
  });

  it('cannot be reproduced without the recovery secret', () => {
    const bucket = Math.floor(Date.now() / RECOVERY_TIME_BUCKET_MS);
    const token = computeRecoveryToken(ORG_ID, SECRET, bucket);
    const forged = computeRecoveryToken(ORG_ID, 'wrong-secret', bucket);
    expect(token).not.toBe(forged);
    expect(activeRecoveryTokens(ORG_ID, SECRET)).toContain(token);
    expect(activeRecoveryTokens(ORG_ID, SECRET)).not.toContain(forged);
  });
});

describe('OrgRecoveryService responder', () => {
  function makeService(view: ReturnType<typeof makeViewEntry>[], nodeStub: any = null) {
    return new OrgRecoveryService({
      getRecoveryView: async () => view,
      getNode: () => nodeStub
    });
  }

  it('answers with member node infos when the token matches a local org', async () => {
    const service = makeService([
      makeViewEntry([
        { peerId: 'QmMember1', addresses: ['/ip4/1.1.1.1/tcp/15002/ws'] },
        { peerId: 'QmMember2', addresses: ['/ip4/2.2.2.2/tcp/15002/ws'] }
      ])
    ]);
    const token = activeRecoveryTokens(ORG_ID, SECRET)[0]!;

    const writes: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'org-recovery-query', token, ttl: 0, want: 8 }), writes),
      connection: { remotePeer: { toString: () => 'QmAsker' } }
    });

    const response = JSON.parse(writes[0] ?? '{}');
    expect(response.ok).toBe(true);
    expect(response.peers.map((item: any) => item.peerId)).toEqual(['QmMember1', 'QmMember2']);
  });

  it('returns empty peers for unknown tokens without leaking org existence', async () => {
    const service = makeService([makeViewEntry([{ peerId: 'QmMember1', addresses: ['/ip4/1.1.1.1/tcp/15002/ws'] }])]);
    const unknownToken = computeRecoveryToken('org_elsewhere', 'other-secret', Math.floor(Date.now() / RECOVERY_TIME_BUCKET_MS));

    const writes: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'org-recovery-query', token: unknownToken, ttl: 0, want: 8 }), writes),
      connection: { remotePeer: { toString: () => 'QmStranger' } }
    });

    const response = JSON.parse(writes[0] ?? '{}');
    expect(response.ok).toBe(true);
    expect(response.peers).toEqual([]);
  });

  it('forwards unanswered queries to connected neighbors with decremented ttl', async () => {
    const forwardedRequests: any[] = [];
    const nodeStub = {
      getConnections: () => [{ remotePeer: { toString: () => 'QmNeighborB' } }],
      dialProtocol: async (_peer: any, _protocol: string) => ({
        source: (async function* () {
          yield Buffer.from(JSON.stringify({
            ok: true,
            type: 'org-recovery-response',
            peers: [{ peerId: 'QmFarMember', addresses: ['/ip4/3.3.3.3/tcp/15002/ws'] }]
          }), 'utf8');
        })(),
        sink: async (source: AsyncIterable<Uint8Array>) => {
          for await (const chunk of source) {
            forwardedRequests.push(JSON.parse(Buffer.from(chunk).toString('utf8')));
          }
        }
      })
    };
    const service = makeService([], nodeStub);
    const token = computeRecoveryToken('org_far', 'far-secret', Math.floor(Date.now() / RECOVERY_TIME_BUCKET_MS));

    const writes: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'org-recovery-query', token, ttl: 2, want: 8 }), writes),
      connection: { remotePeer: { toString: () => 'QmAsker' } }
    });

    const response = JSON.parse(writes[0] ?? '{}');
    expect(response.ok).toBe(true);
    expect(response.peers.map((item: any) => item.peerId)).toEqual(['QmFarMember']);
    expect(forwardedRequests).toHaveLength(1);
    expect(forwardedRequests[0].ttl).toBe(1);
  });

  it('rate-limits repeated queries from the same requester', async () => {
    const service = makeService([makeViewEntry([{ peerId: 'QmMember1', addresses: ['/ip4/1.1.1.1/tcp/15002/ws'] }])]);
    const token = activeRecoveryTokens(ORG_ID, SECRET)[0]!;

    const first: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'org-recovery-query', token, ttl: 0, want: 8 }), first),
      connection: { remotePeer: { toString: () => 'QmAsker' } }
    });
    expect(JSON.parse(first[0] ?? '{}').ok).toBe(true);

    const second: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'org-recovery-query', token, ttl: 0, want: 8 }), second),
      connection: { remotePeer: { toString: () => 'QmAsker' } }
    });
    expect(JSON.parse(second[0] ?? '{}').reason).toBe('rate-limited');
  });
});

describe('P2PNode org recovery trigger', () => {
  it('fires a recovery query after consecutive dead ticks and only dials the hints', async () => {
    const db = new MemoryDb();
    const rootId = 'r'.repeat(64);
    // 本地有组织记录（我是成员），但其它成员没有任何可用地址 → 组织候选为空
    await db.put(`org:meta:${ORG_ID}`, JSON.stringify({
      orgId: ORG_ID,
      name: 'Recovery Org',
      description: '',
      createdAt: 1,
      createdBy: rootId,
      updatedAt: 2,
      recoverySecret: SECRET,
      members: [{ rootId, role: 'admin', joinedAt: 1, addedBy: rootId }]
    }));

    const node = new P2PNode(
      db as any,
      { getCurrentRootId: async () => rootId },
      {
        getRecoveryView: async () => [{
          orgId: ORG_ID,
          recoverySecret: SECRET,
          memberNodeInfos: [{ peerId: MEMBER_ROOT, addresses: [] }]
        }]
      }
    );
    (node as any).node = {
      getConnections: () => [{ remotePeer: { toString: () => 'QmNeighbor' } }]
    };

    const queriedTokens: string[] = [];
    (node as any).orgRecovery.queryRecovery = async (token: string) => {
      queriedTokens.push(token);
      return [{ peerId: 'QmFoundMember', addresses: ['/ip4/9.9.9.9/tcp/15002/ws'] }];
    };
    const dialed: string[] = [];
    (node as any).connectPeer = async (nodeInfo: any) => {
      dialed.push(nodeInfo.peerId);
    };

    // 连续不足 RECOVERY_TRIGGER_CONSECUTIVE_TICKS 个 dead tick 不触发
    for (let index = 0; index < RECOVERY_TRIGGER_CONSECUTIVE_TICKS - 1; index += 1) {
      await node.maintainOrganizationNetwork();
    }
    expect(queriedTokens).toHaveLength(0);

    const result = await node.maintainOrganizationNetwork();
    expect(queriedTokens).toHaveLength(1);
    expect(result.recoveryDialed).toBe(1);
    expect(dialed).toEqual(['QmFoundMember']);

    // 冷却期内不再触发
    await node.maintainOrganizationNetwork();
    expect(queriedTokens).toHaveLength(1);

    // 命中的候选只用于拨号，不写组织成员表
    const orgRecord = JSON.parse((await db.get(`org:meta:${ORG_ID}`)) ?? '{}');
    expect(orgRecord.members).toHaveLength(1);
    expect(orgRecord.members[0].rootId).toBe(rootId);
  });
});

describe('OrganizationService recovery view', () => {
  it('generates recoverySecret on creation and backfills legacy orgs for admins', async () => {
    const db = new MemoryDb();
    const adminRootId = 'a'.repeat(64);
    const service = new OrganizationService(db as any, {
      getCurrentRootId: async () => adminRootId
    }, {}, {});

    const created = await service.createOrganization({ name: 'Recovery Org', basePluginDomain: 'plugin:weibo-core' });
    const createdRecord = JSON.parse((await db.get(`org:meta:${created.orgId}`)) ?? '{}');
    expect(typeof createdRecord.recoverySecret).toBe('string');
    expect(createdRecord.recoverySecret).toHaveLength(64);

    // 存量组织（无恢复盐）由管理员在 getRecoveryView 时惰性补齐
    await db.put('org:meta:org_legacy', JSON.stringify({
      orgId: 'org_legacy',
      name: 'Legacy Org',
      description: '',
      createdAt: 1,
      createdBy: adminRootId,
      updatedAt: 2,
      members: [{
        rootId: adminRootId,
        role: 'admin',
        joinedAt: 1,
        addedBy: adminRootId,
        nodeInfo: { peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] }
      }]
    }));

    const view = await service.getRecoveryView();
    const legacy = view.find((entry) => entry.orgId === 'org_legacy');
    expect(legacy?.recoverySecret).toHaveLength(64);
    expect(legacy?.memberNodeInfos).toEqual([{ peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] }]);

    // 补齐后已落库（下次无需再生成，且能经反熵扩散）
    const persisted = JSON.parse((await db.get('org:meta:org_legacy')) ?? '{}');
    expect(persisted.recoverySecret).toBe(legacy?.recoverySecret);
    expect(persisted.updatedAt).toBeGreaterThan(2);
  });

  it('does not backfill secrets for non-admin members and hides other orgs', async () => {
    const db = new MemoryDb();
    const memberRootId = 'b'.repeat(64);
    const service = new OrganizationService(db as any, {
      getCurrentRootId: async () => memberRootId
    }, {}, {});

    await db.put('org:meta:org_member_only', JSON.stringify({
      orgId: 'org_member_only',
      name: 'Member Org',
      description: '',
      createdAt: 1,
      createdBy: 'a'.repeat(64),
      updatedAt: 2,
      members: [{ rootId: memberRootId, role: 'member', joinedAt: 1, addedBy: 'a'.repeat(64) }]
    }));
    await db.put('org:meta:org_stranger', JSON.stringify({
      orgId: 'org_stranger',
      name: 'Stranger Org',
      description: '',
      createdAt: 1,
      createdBy: 'a'.repeat(64),
      updatedAt: 2,
      recoverySecret: 'x'.repeat(64),
      members: [{ rootId: 'a'.repeat(64), role: 'admin', joinedAt: 1, addedBy: 'a'.repeat(64) }]
    }));

    const view = await service.getRecoveryView();
    expect(view).toHaveLength(0);
    const persisted = JSON.parse((await db.get('org:meta:org_member_only')) ?? '{}');
    expect(persisted.recoverySecret).toBeUndefined();
  });
});
