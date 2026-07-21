import { DIRECT_PEER_EXCHANGE_PROTOCOL, PEER_EXCHANGE_MAX, PEER_EXCHANGE_MAX_AGE_MS, PEER_EXCHANGE_MIN_INTERVAL_MS } from './constants';
import type { OverlayPeerStore } from './overlay-peer-store';
import { parseJsonSafely, readStreamAsString, resolveProtocolStream, writeStringToStream } from './stream-utils';

type PeerExchangeDeps = {
  overlayPeers: OverlayPeerStore;
  getNode: () => any;
};

type ExchangeSample = {
  peerId: string;
  addresses: string[];
  lastSeenAt: number;
};

/**
 * peer-exchange 协议：覆盖网的节点采样交换。
 *
 * 设计要点（HyParView/Cyclon 思路的精简版）：
 * - 交换内容只是"线索"（peerId + 地址 + 最近见到时间），接收方一律按未验证入池；
 * - 响应侧限流并只分享近期见过的条目，避免被当作地址爬虫入口；
 * - 交换来的地址只用于拨号提示，任何组织语义仍由组织层校验链路口径把关。
 */
export class PeerExchangeService {
  private readonly lastServedAtByPeerId = new Map<string, number>();

  constructor(private readonly deps: PeerExchangeDeps) {}

  /** 响应侧：处理入站 peer-exchange 请求（在直连协议 handler 中调用）。 */
  async handleDirectIncoming(incoming: any): Promise<void> {
    const stream = resolveProtocolStream(incoming);
    if (!stream) {
      return;
    }

    try {
      const requestText = await readStreamAsString(stream, 3000);
      const request = parseJsonSafely(requestText, 'peer-exchange request');
      if (request?.type !== 'peer-exchange-request') {
        await writeStringToStream(stream, JSON.stringify({ ok: false, type: 'peer-exchange-response', peers: [] }));
        return;
      }

      const requesterPeerId = typeof incoming?.connection?.remotePeer?.toString === 'function'
        ? incoming.connection.remotePeer.toString()
        : undefined;

      if (requesterPeerId && this.isRateLimited(requesterPeerId)) {
        await writeStringToStream(stream, JSON.stringify({
          ok: false,
          type: 'peer-exchange-response',
          peers: [],
          reason: 'rate-limited'
        }));
        return;
      }

      const want = this.normalizeWant(request.want);
      const peers = await this.sampleForResponse(requesterPeerId, want);
      await writeStringToStream(stream, JSON.stringify({ ok: true, type: 'peer-exchange-response', peers }));
    } catch (error) {
      console.warn('[p2p][peer-exchange] incoming handling failed', { error: String(error) });
    }
  }

  /**
   * 请求侧：向一个已连接邻居发起交换并把结果合并入池。
   * 返回实际合并的条目数；邻居未连接或响应异常时返回 0。
   */
  async exchangeWithPeer(peerId: string, want = PEER_EXCHANGE_MAX): Promise<number> {
    const node = this.deps.getNode();
    if (!node || typeof node.dialProtocol !== 'function') {
      return 0;
    }

    const remotePeer = this.findConnectedRemotePeer(peerId);
    if (!remotePeer) {
      return 0;
    }

    try {
      const streamResult = await node.dialProtocol(remotePeer, DIRECT_PEER_EXCHANGE_PROTOCOL);
      const stream = resolveProtocolStream(streamResult);
      if (!stream) {
        return 0;
      }

      await writeStringToStream(stream, JSON.stringify({ type: 'peer-exchange-request', want }));
      const responseText = await readStreamAsString(stream, 4000);
      const response = parseJsonSafely(responseText, 'peer-exchange response');
      if (!response?.ok || !Array.isArray(response.peers)) {
        return 0;
      }

      const selfPeerId = typeof node.peerId?.toString === 'function' ? node.peerId.toString() : '';
      let merged = 0;
      for (const item of response.peers.slice(0, PEER_EXCHANGE_MAX)) {
        if (!item || typeof item.peerId !== 'string' || !Array.isArray(item.addresses)) {
          continue;
        }
        if (item.peerId === selfPeerId || item.peerId === peerId) {
          continue;
        }
        const addresses = item.addresses
          .filter((address: unknown) => typeof address === 'string' && address.length > 0)
          .slice(0, 20);
        if (addresses.length === 0) {
          continue;
        }
        await this.deps.overlayPeers.remember(item.peerId, addresses, 'exchange', false);
        merged += 1;
      }
      return merged;
    } catch (error) {
      console.warn('[p2p][peer-exchange] exchange failed', { peerId, error: String(error) });
      return 0;
    }
  }

  private normalizeWant(raw: unknown): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return PEER_EXCHANGE_MAX;
    }
    return Math.min(parsed, PEER_EXCHANGE_MAX);
  }

  private isRateLimited(requesterPeerId: string): boolean {
    const now = Date.now();
    const lastServedAt = this.lastServedAtByPeerId.get(requesterPeerId) ?? 0;
    if (now - lastServedAt < PEER_EXCHANGE_MIN_INTERVAL_MS) {
      return true;
    }
    this.lastServedAtByPeerId.set(requesterPeerId, now);
    return false;
  }

  /** 响应抽样：排除请求方、排除陈旧条目，verified 优先、按最近见过排序。 */
  private async sampleForResponse(excludePeerId: string | undefined, want: number): Promise<ExchangeSample[]> {
    const cutoff = Date.now() - PEER_EXCHANGE_MAX_AGE_MS;
    const all = await this.deps.overlayPeers.listAll();
    return all
      .filter((record) =>
        record.peerId !== excludePeerId &&
        record.addresses.length > 0 &&
        record.lastSeenAt >= cutoff
      )
      .sort((a, b) => {
        if (a.verified !== b.verified) {
          return a.verified ? -1 : 1;
        }
        return b.lastSeenAt - a.lastSeenAt;
      })
      .slice(0, want)
      .map((record) => ({
        peerId: record.peerId,
        addresses: record.addresses,
        lastSeenAt: record.lastSeenAt
      }));
  }

  private findConnectedRemotePeer(peerId: string): any | null {
    const node = this.deps.getNode();
    if (!node || typeof node.getConnections !== 'function') {
      return null;
    }

    const connections = node.getConnections();
    if (!Array.isArray(connections)) {
      return null;
    }

    for (const connection of connections) {
      const remotePeer = connection?.remotePeer;
      const normalized = typeof remotePeer?.toString === 'function' ? remotePeer.toString() : String(remotePeer ?? '');
      if (normalized === peerId) {
        return remotePeer;
      }
    }
    return null;
  }
}
