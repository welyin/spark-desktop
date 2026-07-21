import { describe, expect, it } from 'vitest';
import { P2P_OVERLAY_PEER_PREFIX, PEER_EXCHANGE_MAX_AGE_MS } from '../../../main/p2p/constants';
import { OverlayPeerStore } from '../../../main/p2p/overlay-peer-store';
import { PeerExchangeService } from '../../../main/p2p/peer-exchange';
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

function makeRecord(peerId: string, overrides: Record<string, unknown> = {}) {
  return {
    peerId,
    addresses: [`/ip4/127.0.0.1/tcp/10000/ws/p2p/${peerId}`],
    firstSeenAt: 1,
    lastSeenAt: Date.now(),
    source: 'connect',
    verified: false,
    ...overrides
  };
}

describe('PeerExchangeService responder', () => {
  it('serves a capped sample excluding the requester and stale entries', async () => {
    const db = new MemoryDb() as any;
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmFresh`, JSON.stringify(makeRecord('QmFresh')));
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmRequester`, JSON.stringify(makeRecord('QmRequester')));
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmStale`, JSON.stringify(makeRecord('QmStale', { lastSeenAt: Date.now() - PEER_EXCHANGE_MAX_AGE_MS - 1000 })));
    await db.put(`${P2P_OVERLAY_PEER_PREFIX}QmNoAddr`, JSON.stringify(makeRecord('QmNoAddr', { addresses: [] })));

    const service = new PeerExchangeService({
      overlayPeers: new OverlayPeerStore(db),
      getNode: () => null
    });

    const writes: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'peer-exchange-request', want: 10 }), writes),
      connection: { remotePeer: { toString: () => 'QmRequester' } }
    });

    const response = JSON.parse(writes[0] ?? '{}');
    expect(response.ok).toBe(true);
    expect(response.peers.map((item: any) => item.peerId)).toEqual(['QmFresh']);
  });

  it('rate-limits repeated requests from the same peer', async () => {
    const service = new PeerExchangeService({
      overlayPeers: new OverlayPeerStore(new MemoryDb() as any),
      getNode: () => null
    });

    const first: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'peer-exchange-request', want: 5 }), first),
      connection: { remotePeer: { toString: () => 'QmRequester' } }
    });
    expect(JSON.parse(first[0] ?? '{}').ok).toBe(true);

    const second: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream(JSON.stringify({ type: 'peer-exchange-request', want: 5 }), second),
      connection: { remotePeer: { toString: () => 'QmRequester' } }
    });
    const rejected = JSON.parse(second[0] ?? '{}');
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('rate-limited');
  });

  it('rejects malformed requests without throwing', async () => {
    const service = new PeerExchangeService({
      overlayPeers: new OverlayPeerStore(new MemoryDb() as any),
      getNode: () => null
    });

    const writes: string[] = [];
    await service.handleDirectIncoming({
      stream: makeFakeStream('not-json', writes),
      connection: { remotePeer: { toString: () => 'QmRequester' } }
    });
    expect(JSON.parse(writes[0] ?? '{}').ok).toBe(false);
  });
});

describe('PeerExchangeService requester', () => {
  function makeNodeStub(response: unknown, sentRequests: unknown[]) {
    return {
      peerId: { toString: () => 'QmSelf' },
      getConnections: () => [{ remotePeer: { toString: () => 'QmNeighbor' } }],
      dialProtocol: async () => ({
        source: (async function* () {
          yield Buffer.from(JSON.stringify(response), 'utf8');
        })(),
        sink: async (source: AsyncIterable<Uint8Array>) => {
          for await (const chunk of source) {
            sentRequests.push(JSON.parse(Buffer.from(chunk).toString('utf8')));
          }
        }
      })
    };
  }

  it('merges exchanged peers into the pool as unverified hints', async () => {
    const db = new MemoryDb() as any;
    const sentRequests: unknown[] = [];
    const service = new PeerExchangeService({
      overlayPeers: new OverlayPeerStore(db),
      getNode: () => makeNodeStub({
        ok: true,
        type: 'peer-exchange-response',
        peers: [
          { peerId: 'QmPeerA', addresses: ['/ip4/1.2.3.4/tcp/15002/ws'], lastSeenAt: 1 },
          { peerId: 'QmSelf', addresses: ['/ip4/9.9.9.9/tcp/15002/ws'], lastSeenAt: 1 },
          { peerId: 'QmNeighbor', addresses: ['/ip4/8.8.8.8/tcp/15002/ws'], lastSeenAt: 1 },
          { peerId: 'QmEmpty', addresses: [], lastSeenAt: 1 }
        ]
      }, sentRequests)
    });

    const merged = await service.exchangeWithPeer('QmNeighbor');

    expect(merged).toBe(1);
    expect(sentRequests).toEqual([{ type: 'peer-exchange-request', want: 16 }]);
    const all = await new OverlayPeerStore(db).listAll();
    expect(all.map((record) => record.peerId)).toEqual(['QmPeerA']);
    expect(all[0]?.verified).toBe(false);
    expect(all[0]?.source).toBe('exchange');
  });

  it('returns 0 when the target peer is not connected', async () => {
    const service = new PeerExchangeService({
      overlayPeers: new OverlayPeerStore(new MemoryDb() as any),
      getNode: () => ({
        getConnections: () => []
      })
    });

    expect(await service.exchangeWithPeer('QmGhost')).toBe(0);
  });
});

describe('P2PNode peer-exchange tick wiring', () => {
  it('exchanges with one connected neighbor per tick', async () => {
    const node = new P2PNode(new MemoryDb() as any);
    (node as any).node = {
      getConnections: () => [{ remotePeer: { toString: () => 'QmNeighbor' } }]
    };

    const exchangedWith: string[] = [];
    (node as any).peerExchange.exchangeWithPeer = async (peerId: string) => {
      exchangedWith.push(peerId);
      return 3;
    };

    const result = await node.maintainOverlayNetwork();

    // 连接数未低于目标时不补拨，但交换照常发生
    expect(result.overlayDialed).toBe(0);
    expect(result.exchanged).toBe(3);
    expect(exchangedWith).toEqual(['QmNeighbor']);
  });
});
