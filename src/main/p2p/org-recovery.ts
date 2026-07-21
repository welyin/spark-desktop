import { createHash } from 'crypto';
import { DIRECT_ORG_RECOVERY_PROTOCOL, RECOVERY_QUERY_MIN_INTERVAL_MS, RECOVERY_QUERY_WANT, RECOVERY_TIME_BUCKET_MS, RECOVERY_TTL } from './constants';
import { parseJsonSafely, readStreamAsString, resolveProtocolStream, writeStringToStream } from './stream-utils';
import type { PeerNodeInfo } from './types';

/**
 * 组织恢复查询视图条目：本机当前身份是某组织成员时，
 * 由 organization 服务提供的恢复参数（恢复盐 + 成员地址）。
 */
export type RecoveryViewEntry = {
  orgId: string;
  recoverySecret: string;
  memberNodeInfos: PeerNodeInfo[];
};

type OrgRecoveryDeps = {
  getRecoveryView: () => Promise<RecoveryViewEntry[]>;
  getNode: () => any;
};

type RecoveryQueryRequest = {
  type: 'org-recovery-query';
  token: string;
  ttl: number;
  want: number;
};

/**
 * 恢复查询 token：H(orgId + recoverySecret + timeBucket)。
 * 恢复盐只存在于成员本地组织记录中，非成员看到 token 也无法反推 orgId
 * 或枚举组织存在性；时间桶让 token 周期性变化，抑制长期跟踪。
 */
export function computeRecoveryToken(orgId: string, recoverySecret: string, timeBucket: number): string {
  return createHash('sha256').update(`${orgId}:${recoverySecret}:${timeBucket}`).digest('hex');
}

/** 当前生效的 token 集合（当前桶 + 上一桶，消除桶边界漏配） */
export function activeRecoveryTokens(orgId: string, recoverySecret: string, nowMs = Date.now()): string[] {
  const bucket = Math.floor(nowMs / RECOVERY_TIME_BUCKET_MS);
  return [computeRecoveryToken(orgId, recoverySecret, bucket), computeRecoveryToken(orgId, recoverySecret, bucket - 1)];
}

/**
 * org-recovery 协议：组织失联时的定向恢复查询。
 *
 * 设计要点：
 * - 查的是"知道这个组织有效节点的人"，不是"组织"本身；应答内容来自应答方
 *   本地成员记录（本来就是成员间共享数据）；
 * - 未命中且 ttl>0 时向自己的活跃覆盖网邻居有限转发（最多 RECOVERY_TTL 跳），
 *   不做全网洪泛；
 * - 命中结果只作为拨号提示，调用方拨号后仍走既有组织校验链路口径。
 */
export class OrgRecoveryService {
  private readonly lastServedAtByPeerId = new Map<string, number>();

  constructor(private readonly deps: OrgRecoveryDeps) {}

  /** 响应侧：处理入站恢复查询（在直连协议 handler 中调用）。 */
  async handleDirectIncoming(incoming: any): Promise<void> {
    const stream = resolveProtocolStream(incoming);
    if (!stream) {
      return;
    }

    try {
      const requestText = await readStreamAsString(stream, 3000);
      const request = parseJsonSafely(requestText, 'org-recovery request');
      if (request?.type !== 'org-recovery-query' || typeof request.token !== 'string' || !/^[0-9a-f]{64}$/.test(request.token)) {
        await writeStringToStream(stream, JSON.stringify({ ok: false, type: 'org-recovery-response', peers: [] }));
        return;
      }

      const requesterPeerId = typeof incoming?.connection?.remotePeer?.toString === 'function'
        ? incoming.connection.remotePeer.toString()
        : undefined;
      if (requesterPeerId && this.isRateLimited(requesterPeerId)) {
        await writeStringToStream(stream, JSON.stringify({
          ok: false,
          type: 'org-recovery-response',
          peers: [],
          reason: 'rate-limited'
        }));
        return;
      }

      const peers = await this.answerQuery(request as RecoveryQueryRequest, requesterPeerId);
      await writeStringToStream(stream, JSON.stringify({ ok: true, type: 'org-recovery-response', peers }));
    } catch (error) {
      console.warn('[p2p][org-recovery] incoming handling failed', { error: String(error) });
    }
  }

  /** 命中本地组织则返回成员条目；否则按 ttl 向活跃覆盖网邻居有限转发。 */
  private async answerQuery(request: RecoveryQueryRequest, requesterPeerId?: string): Promise<PeerNodeInfo[]> {
    const want = this.normalizeWant(request.want);
    const view = await this.deps.getRecoveryView();
    for (const entry of view) {
      if (!activeRecoveryTokens(entry.orgId, entry.recoverySecret).includes(request.token)) {
        continue;
      }
      return entry.memberNodeInfos.slice(0, want);
    }

    const ttl = Math.min(Math.max(0, Number(request.ttl) || 0), RECOVERY_TTL);
    if (ttl <= 0) {
      return [];
    }

    const neighbors = this.getConnectedPeerIds()
      .filter((peerId) => peerId !== requesterPeerId)
      .slice(0, 2);
    const forwarded = await Promise.all(
      neighbors.map((peerId) => this.queryPeer(peerId, request.token, ttl - 1, want).catch(() => []))
    );
    return this.dedupePeers(forwarded.flat()).slice(0, want);
  }

  /** 请求侧：向一组活跃邻居发出恢复查询，返回去重后的候选成员地址。 */
  async queryRecovery(token: string, neighborPeerIds: string[], want = RECOVERY_QUERY_WANT): Promise<PeerNodeInfo[]> {
    const results = await Promise.all(
      neighborPeerIds.slice(0, 3).map((peerId) => this.queryPeer(peerId, token, RECOVERY_TTL, want).catch(() => []))
    );
    return this.dedupePeers(results.flat()).slice(0, RECOVERY_QUERY_WANT * 2);
  }

  private async queryPeer(peerId: string, token: string, ttl: number, want: number): Promise<PeerNodeInfo[]> {
    const node = this.deps.getNode();
    if (!node || typeof node.dialProtocol !== 'function') {
      return [];
    }

    const remotePeer = this.findConnectedRemotePeer(peerId);
    if (!remotePeer) {
      return [];
    }

    const streamResult = await node.dialProtocol(remotePeer, DIRECT_ORG_RECOVERY_PROTOCOL);
    const stream = resolveProtocolStream(streamResult);
    if (!stream) {
      return [];
    }

    await writeStringToStream(stream, JSON.stringify({ type: 'org-recovery-query', token, ttl, want }));
    const responseText = await readStreamAsString(stream, 3000);
    const response = parseJsonSafely(responseText, 'org-recovery response');
    if (!response?.ok || !Array.isArray(response.peers)) {
      return [];
    }

    return response.peers
      .filter((item: any) => item && (typeof item.peerId === 'string' || Array.isArray(item.addresses)))
      .map((item: any) => ({
        peerId: typeof item.peerId === 'string' ? item.peerId : undefined,
        addresses: Array.isArray(item.addresses)
          ? item.addresses.filter((address: unknown) => typeof address === 'string' && address.length > 0).slice(0, 20)
          : []
      }))
      .filter((item: PeerNodeInfo) => item.addresses.length > 0);
  }

  private normalizeWant(raw: unknown): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return RECOVERY_QUERY_WANT;
    }
    return Math.min(parsed, RECOVERY_QUERY_WANT);
  }

  private isRateLimited(requesterPeerId: string): boolean {
    const now = Date.now();
    const lastServedAt = this.lastServedAtByPeerId.get(requesterPeerId) ?? 0;
    if (now - lastServedAt < RECOVERY_QUERY_MIN_INTERVAL_MS) {
      return true;
    }
    this.lastServedAtByPeerId.set(requesterPeerId, now);
    return false;
  }

  private dedupePeers(peers: PeerNodeInfo[]): PeerNodeInfo[] {
    const byPeerId = new Map<string, PeerNodeInfo>();
    const anonymous: PeerNodeInfo[] = [];
    for (const peer of peers) {
      if (peer.peerId) {
        const existing = byPeerId.get(peer.peerId);
        byPeerId.set(peer.peerId, {
          peerId: peer.peerId,
          addresses: Array.from(new Set([...(existing?.addresses ?? []), ...peer.addresses]))
        });
        continue;
      }
      anonymous.push(peer);
    }
    return [...byPeerId.values(), ...anonymous];
  }

  private getConnectedPeerIds(): string[] {
    const node = this.deps.getNode();
    if (!node || typeof node.getConnections !== 'function') {
      return [];
    }
    const connections = node.getConnections();
    if (!Array.isArray(connections)) {
      return [];
    }
    const peerIds = connections
      .map((connection: any) => connection?.remotePeer)
      .filter(Boolean)
      .map((peer: any) => (typeof peer.toString === 'function' ? peer.toString() : String(peer)));
    return Array.from(new Set(peerIds));
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
