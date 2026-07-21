import type { LevelDB } from '../db/base';
import { OVERLAY_POOL_MAX, P2P_OVERLAY_PEER_PREFIX } from './constants';

/**
 * 覆盖网邻居来源：
 * - connect：曾经直连成功（含组织成员、relay、mDNS，连接事件里沉淀）
 * - exchange：peer-exchange 协议换来的第三方线索
 * - announce：node-announce 签名通告（已验签，可信度高）
 * - org：组织成员表回填
 * - mdns：局域网发现
 */
export type OverlayPeerSource = 'connect' | 'exchange' | 'announce' | 'org' | 'mdns';

/**
 * 覆盖网邻居记录（组织无关的地址簿条目）。
 * 与 PeerActivityRecord 的区别：这里只关心"这个 peer 在哪里、最近什么时候见过"，
 * 不做活跃度评分，也不因连续拨号失败清除——失联已久的节点可能正是组织恢复时
 * 唯一能指路的线索。
 */
export type OverlayPeerRecord = {
  peerId: string;
  addresses: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  source: OverlayPeerSource;
  /** announce 验签通过即视为地址可信；exchange/connect 来源仅为提示 */
  verified: boolean;
  lastDialResult?: 'success' | 'failure';
};

/** 单个 peer 最多保留的地址条数（防地址无限堆积） */
const MAX_ADDRESSES_PER_PEER = 20;

/**
 * 覆盖网邻居池：独立于组织的长期 peer 地址簿。
 *
 * 职责：
 * 1) 记录网络层见过的一切 Spark 节点（不看组织归属）；
 * 2) 为 keepalive 提供组织无关的拨号候选，维持覆盖网长期存活；
 * 3) 为 peer-exchange / org-recovery 提供抽样与应答数据。
 */
export class OverlayPeerStore {
  private readonly cache = new Map<string, OverlayPeerRecord>();

  constructor(private readonly db: LevelDB) {}

  private key(peerId: string): string {
    return `${P2P_OVERLAY_PEER_PREFIX}${peerId}`;
  }

  private async get(peerId: string): Promise<OverlayPeerRecord | null> {
    const cached = this.cache.get(peerId);
    if (cached) {
      return { ...cached, addresses: [...cached.addresses] };
    }

    const raw = await this.db.get(this.key(peerId));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as OverlayPeerRecord;
      if (typeof parsed?.peerId !== 'string' || !Array.isArray(parsed.addresses)) {
        return null;
      }
      this.cache.set(peerId, parsed);
      return { ...parsed, addresses: [...parsed.addresses] };
    } catch {
      return null;
    }
  }

  private async save(record: OverlayPeerRecord): Promise<void> {
    this.cache.set(record.peerId, record);
    await this.db.put(this.key(record.peerId), JSON.stringify(record));
  }

  /**
   * 记录一个覆盖网邻居：按 peerId 合并地址并刷新 lastSeenAt。
   * verified 只升不降（announce 验签通过后，后续低可信来源不会把它拉回去）。
   */
  async remember(peerId: string, addresses: string[], source: OverlayPeerSource, verified = false): Promise<void> {
    const normalizedPeerId = peerId.trim();
    if (!normalizedPeerId) {
      return;
    }

    const now = Date.now();
    const existing = await this.get(normalizedPeerId);
    const mergedAddresses = Array.from(new Set([
      ...(existing?.addresses ?? []),
      ...addresses.map((item) => item.trim()).filter((item) => item.length > 0)
    ])).slice(0, MAX_ADDRESSES_PER_PEER);

    await this.save({
      peerId: normalizedPeerId,
      addresses: mergedAddresses,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      source,
      verified: Boolean(existing?.verified) || verified,
      lastDialResult: existing?.lastDialResult
    });

    await this.evictIfNeeded();
  }

  /** 记录一次拨号结果（仅影响排序提示，不触发清除）。 */
  async markDialResult(peerId: string, result: 'success' | 'failure'): Promise<void> {
    const existing = await this.get(peerId);
    if (!existing) {
      return;
    }
    await this.save({ ...existing, lastDialResult: result });
  }

  async listAll(): Promise<OverlayPeerRecord[]> {
    const rows = await this.db.queryRange({
      prefix: P2P_OVERLAY_PEER_PREFIX,
      start: P2P_OVERLAY_PEER_PREFIX,
      end: `${P2P_OVERLAY_PEER_PREFIX}\xFF`
    });

    const records: OverlayPeerRecord[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as OverlayPeerRecord;
        if (typeof parsed?.peerId === 'string' && Array.isArray(parsed.addresses)) {
          records.push(parsed);
          this.cache.set(parsed.peerId, parsed);
        }
      } catch {
        // ignore invalid row
      }
    }
    return records;
  }

  /**
   * 抽取拨号候选：verified 优先，其次按最近见过排序。
   * 连续失败次数不参与排序——覆盖网池不做"失败即降权"，旧线索同样宝贵。
   */
  async sampleDialCandidates(excludePeerIds: Set<string>, limit: number): Promise<OverlayPeerRecord[]> {
    const all = await this.listAll();
    return all
      .filter((record) => !excludePeerIds.has(record.peerId) && record.addresses.length > 0)
      .sort((a, b) => {
        if (a.verified !== b.verified) {
          return a.verified ? -1 : 1;
        }
        return b.lastSeenAt - a.lastSeenAt;
      })
      .slice(0, Math.max(0, limit));
  }

  /**
   * 容量淘汰：超限时优先淘汰最久未见的未验证条目；
   * 全部都已验证时才淘汰最久未见的验证条目。失败记录不触发淘汰。
   */
  private async evictIfNeeded(): Promise<void> {
    const all = await this.listAll();
    if (all.length <= OVERLAY_POOL_MAX) {
      return;
    }

    const excess = all.length - OVERLAY_POOL_MAX;
    const byEvictionOrder = [...all].sort((a, b) => {
      if (a.verified !== b.verified) {
        return a.verified ? 1 : -1;
      }
      return a.lastSeenAt - b.lastSeenAt;
    });

    for (const victim of byEvictionOrder.slice(0, excess)) {
      this.cache.delete(victim.peerId);
      await this.db.del(this.key(victim.peerId));
    }
  }
}
