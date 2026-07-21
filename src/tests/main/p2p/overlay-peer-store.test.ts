import { describe, expect, it } from 'vitest';
import { OVERLAY_POOL_MAX, P2P_OVERLAY_PEER_PREFIX } from '../../../main/p2p/constants';
import { OverlayPeerStore } from '../../../main/p2p/overlay-peer-store';
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

  get size(): number {
    return this.store.size;
  }
}

function makeRecord(peerId: string, overrides: Record<string, unknown> = {}) {
  return {
    peerId,
    addresses: [`/ip4/127.0.0.1/tcp/10000/ws/p2p/${peerId}`],
    firstSeenAt: 1,
    lastSeenAt: 1,
    source: 'exchange',
    verified: false,
    ...overrides
  };
}

describe('OverlayPeerStore', () => {
  it('merges addresses and refreshes lastSeenAt on remember', async () => {
    const store = new OverlayPeerStore(new MemoryDb() as any);

    await store.remember('QmA', ['/ip4/10.0.0.1/tcp/1/ws'], 'exchange');
    await store.remember('QmA', ['/ip4/10.0.0.1/tcp/1/ws', '/ip4/10.0.0.2/tcp/2/ws'], 'connect');

    const [record] = await store.listAll();
    expect(record?.addresses).toEqual(['/ip4/10.0.0.1/tcp/1/ws', '/ip4/10.0.0.2/tcp/2/ws']);
    expect(record?.source).toBe('connect');
    expect(record?.verified).toBe(false);
    expect(record?.lastSeenAt).toBeGreaterThanOrEqual(record?.firstSeenAt ?? 0);
  });

  it('keeps verified=true once set (only upgrades, never downgrades)', async () => {
    const store = new OverlayPeerStore(new MemoryDb() as any);

    await store.remember('QmA', ['/ip4/10.0.0.1/tcp/1/ws'], 'announce', true);
    await store.remember('QmA', ['/ip4/10.0.0.1/tcp/1/ws'], 'exchange', false);

    const [record] = await store.listAll();
    expect(record?.verified).toBe(true);
  });

  it('samples dial candidates with verified first, then most recent, honoring exclusions', async () => {
    const db = new MemoryDb() as any;
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmOld`, JSON.stringify(makeRecord('QmOld', { lastSeenAt: 10, verified: true })));
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmNew`, JSON.stringify(makeRecord('QmNew', { lastSeenAt: 20 })));
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmNoAddr`, JSON.stringify(makeRecord('QmNoAddr', { addresses: [], lastSeenAt: 30 })));

    const store = new OverlayPeerStore(db);
    const sampled = await store.sampleDialCandidates(new Set(), 10);

    expect(sampled.map((item) => item.peerId)).toEqual(['QmOld', 'QmNew']);
    const excluded = await store.sampleDialCandidates(new Set(['QmOld']), 10);
    expect(excluded.map((item) => item.peerId)).toEqual(['QmNew']);
  });

  it('evicts oldest unverified records beyond pool capacity but keeps verified ones', async () => {
    const db = new MemoryDb() as any;
    for (let index = 0; index < OVERLAY_POOL_MAX; index += 1) {
      const peerId = `QmOld${String(index).padStart(4, '0')}`;
      await db.put(`${P2P_OVERLAY_PEER_PREFIX}${peerId}`, JSON.stringify(makeRecord(peerId, { lastSeenAt: index })));
    }
    const store = new OverlayPeerStore(db);

    await store.remember('QmVerifiedNew', ['/ip4/10.0.0.9/tcp/9/ws'], 'announce', true);

    const all = await store.listAll();
    expect(all.length).toBe(OVERLAY_POOL_MAX);
    expect(all.some((record) => record.peerId === 'QmVerifiedNew')).toBe(true);
    // 最久未见的未验证条目应被淘汰
    expect(all.some((record) => record.peerId === 'QmOld0000')).toBe(false);
  });

  it('never purges records for repeated dial failures', async () => {
    const store = new OverlayPeerStore(new MemoryDb() as any);
    await store.remember('QmFlaky', ['/ip4/10.0.0.1/tcp/1/ws'], 'exchange');

    for (let index = 0; index < 20; index += 1) {
      await store.markDialResult('QmFlaky', 'failure');
    }

    const [record] = await store.listAll();
    expect(record?.peerId).toBe('QmFlaky');
    expect(record?.lastDialResult).toBe('failure');
  });
});

describe('P2PNode overlay wiring', () => {
  function makeNode(db: MemoryDb, currentRootId: string | null = null) {
    const node = new P2PNode(db as any, { getCurrentRootId: async () => currentRootId });
    (node as any).node = {
      getConnections: () => []
    };
    return node;
  }

  it('dials overlay pool candidates when below the active-connection target', async () => {
    const db = new MemoryDb();
    const node = makeNode(db);
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmOverlay1`, JSON.stringify(makeRecord('QmOverlay1', { lastSeenAt: 10 })));
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmOverlay2`, JSON.stringify(makeRecord('QmOverlay2', { lastSeenAt: 20 })));

    const dialed: string[] = [];
    (node as any).connectPeer = async (nodeInfo: any) => {
      dialed.push(nodeInfo.peerId);
    };

    const result = await node.maintainOverlayNetwork();

    expect(result.overlayDialed).toBe(2);
    expect(dialed).toEqual(['QmOverlay2', 'QmOverlay1']);
    const records = await (node as any).overlayPeers.listAll();
    expect(records.every((record: any) => record.lastDialResult === 'success')).toBe(true);
  });

  it('records dial failures without removing pool entries', async () => {
    const db = new MemoryDb();
    const node = makeNode(db);
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmBad`, JSON.stringify(makeRecord('QmBad', { lastSeenAt: 10 })));

    (node as any).connectPeer = async () => {
      throw new Error('unreachable');
    };

    const result = await node.maintainOverlayNetwork();

    expect(result.overlayDialed).toBe(0);
    const [record] = await (node as any).overlayPeers.listAll();
    expect(record?.peerId).toBe('QmBad');
    expect(record?.lastDialResult).toBe('failure');
  });

  it('maintains the overlay even when identity is unavailable (org side dead)', async () => {
    const db = new MemoryDb();
    const node = makeNode(db, null);
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmOverlay`, JSON.stringify(makeRecord('QmOverlay', { lastSeenAt: 10 })));

    const dialed: string[] = [];
    (node as any).connectPeer = async (nodeInfo: any) => {
      dialed.push(nodeInfo.peerId);
    };

    const result = await node.maintainOrganizationNetwork();

    expect(result.dialed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.overlayDialed).toBe(1);
    expect(dialed).toEqual(['QmOverlay']);
  });

  it('dials the overlay pool first when bootstrapping on login', async () => {
    const db = new MemoryDb();
    const rootId = 'a'.repeat(64);
    const node = makeNode(db, rootId);
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmOverlay`, JSON.stringify(makeRecord('QmOverlay', { lastSeenAt: 10 })));

    const dialed: string[] = [];
    (node as any).connectPeer = async (nodeInfo: any) => {
      dialed.push(nodeInfo.peerId);
    };

    // 无任何组织候选时，登录引导仍应先把覆盖网拨起来
    const result = await node.bootstrapOrganizationNetworkOnLogin();

    expect(result.attempted).toBe(0);
    expect(dialed).toEqual(['QmOverlay']);
  });
});
