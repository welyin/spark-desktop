import type { LevelDB } from '../db/base';
import { ORG_META_PREFIX, P2P_PEER_RECORD_PREFIX } from './constants';
import type { PeerActivityRecord, PeerNodeInfo } from './types';

type ExtractPeerIdFn = (nodeInfo: PeerNodeInfo) => string | null;

/**
 * 节点活跃度持久化仓库。
 *
 * 负责三类能力：
 * 1) 记录每个 peer 的连接成功/失败与在线累计时长；
 * 2) 从组织元数据收集候选节点；
 * 3) 按活跃度评分排序，为登录重连提供稳定优先级。
 */
export class PeerActivityStore {
  private readonly cache = new Map<string, PeerActivityRecord>();

  constructor(
    private readonly db: LevelDB,
    private readonly extractPeerId: ExtractPeerIdFn
  ) {}

  /** 生成某个 peer 的记录键名。 */
  private peerRecordKey(peerId: string): string {
    return `${P2P_PEER_RECORD_PREFIX}${peerId}`;
  }

  /** 读取单个 peer 记录（优先内存缓存，回退到 LevelDB）。 */
  private async get(peerId: string): Promise<PeerActivityRecord | null> {
    if (!peerId) {
      return null;
    }

    const cached = this.cache.get(peerId);
    if (cached) {
      return { ...cached };
    }

    const raw = await this.db.get(this.peerRecordKey(peerId));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as PeerActivityRecord;
      this.cache.set(peerId, parsed);
      return { ...parsed };
    } catch {
      return null;
    }
  }

  /** 写入记录到缓存与数据库。 */
  private async save(record: PeerActivityRecord): Promise<void> {
    this.cache.set(record.peerId, record);
    await this.db.put(this.peerRecordKey(record.peerId), JSON.stringify(record));
  }

  /** 初始化新 peer 的默认统计结构。 */
  private newRecord(peerId: string, now: number): PeerActivityRecord {
    return {
      peerId,
      addresses: [],
      firstSeenAt: now,
      lastSeenAt: now,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      successCount: 0,
      failureCount: 0,
      cumulativeConnectedMs: 0
    };
  }

  /**
   * 记录节点观察结果。
   * seen 仅刷新地址与最近时间；success/failure 会累计连接结果统计。
   */
  async rememberNodeInfo(nodeInfo: PeerNodeInfo, result: 'success' | 'failure' | 'seen', error?: unknown): Promise<void> {
    const peerId = this.extractPeerId(nodeInfo);
    if (!peerId) {
      return;
    }

    const now = Date.now();
    const existing = await this.get(peerId);
    const next = existing ?? this.newRecord(peerId, now);

    const mergedAddresses = Array.from(new Set([
      ...next.addresses,
      ...nodeInfo.addresses.map((item) => item.trim()).filter((item) => item.length > 0)
    ]));
    next.addresses = mergedAddresses;
    next.lastSeenAt = now;

    if (result === 'success') {
      next.successCount += 1;
      next.lastConnectedAt = now;
    }
    if (result === 'failure') {
      next.failureCount += 1;
      next.lastError = error instanceof Error ? error.message : String(error);
    }

    await this.save(next);
  }

  /** 标记已连接：写入当前会话起点，用于断开时结算在线时长。 */
  async markConnected(peerId: string): Promise<void> {
    const now = Date.now();
    const existing = await this.get(peerId);
    const next = existing ?? this.newRecord(peerId, now);

    next.lastSeenAt = now;
    next.lastConnectedAt = now;
    next.currentSessionConnectedAt = next.currentSessionConnectedAt ?? now;
    await this.save(next);
  }

  /** 标记已断开：累计在线时长并清除会话连接起点。 */
  async markDisconnected(peerId: string): Promise<void> {
    const now = Date.now();
    const existing = await this.get(peerId);
    if (!existing) {
      return;
    }

    if (existing.currentSessionConnectedAt) {
      existing.cumulativeConnectedMs += Math.max(0, now - existing.currentSessionConnectedAt);
      delete existing.currentSessionConnectedAt;
    }
    existing.lastSeenAt = now;
    existing.lastDisconnectedAt = now;
    await this.save(existing);
  }

  /** 扫描数据库中的全部 peer 记录。 */
  private async listAll(): Promise<PeerActivityRecord[]> {
    const rows = await this.db.queryRange({
      prefix: P2P_PEER_RECORD_PREFIX,
      start: P2P_PEER_RECORD_PREFIX,
      end: `${P2P_PEER_RECORD_PREFIX}\xFF`
    });

    const records: PeerActivityRecord[] = [];
    for (const row of rows) {
      try {
        records.push(JSON.parse(row.value) as PeerActivityRecord);
      } catch {
        // ignore invalid row
      }
    }
    return records;
  }

  /**
   * 计算节点优先级：
   * - 累计在线时长、成功次数提升分数；
   * - 失败次数与离当前时间越久会降权。
   */
  private computePriority(record: PeerActivityRecord): number {
    const recencyBoost = Math.max(0, Date.now() - record.lastSeenAt);
    return (record.cumulativeConnectedMs + record.successCount * 60_000) - (record.failureCount * 30_000) - recencyBoost;
  }

  /**
   * 收集当前 rootId 所属组织中的其它成员节点。
   * 同一 peerId 会合并地址，避免重复拨号。
   */
  async collectOrganizationPeerCandidates(currentRootId: string): Promise<PeerNodeInfo[]> {
    const rows = await this.db.queryRange({
      prefix: ORG_META_PREFIX,
      start: ORG_META_PREFIX,
      end: `${ORG_META_PREFIX}\xFF`
    });

    const byPeer = new Map<string, PeerNodeInfo>();
    const byAddress = new Map<string, PeerNodeInfo>();

    for (const row of rows) {
      try {
        const org = JSON.parse(row.value) as any;
        const members = Array.isArray(org?.members) ? org.members : [];
        const containsCurrent = members.some((member: any) => member?.rootId === currentRootId);
        if (!containsCurrent) {
          continue;
        }

        for (const member of members) {
          if (!member?.nodeInfo || member.rootId === currentRootId) {
            continue;
          }
          const candidate: PeerNodeInfo = {
            peerId: member.nodeInfo.peerId,
            addresses: Array.isArray(member.nodeInfo.addresses) ? member.nodeInfo.addresses : []
          };
          const candidatePeerId = this.extractPeerId(candidate);
          if (candidatePeerId) {
            const existing = byPeer.get(candidatePeerId);
            byPeer.set(candidatePeerId, {
              peerId: candidatePeerId,
              addresses: Array.from(new Set([...(existing?.addresses ?? []), ...candidate.addresses]))
            });
            continue;
          }

          const key = candidate.addresses.join('|');
          if (key.length > 0) {
            byAddress.set(key, candidate);
          }
        }
      } catch {
        // ignore invalid org record
      }
    }

    return [...byPeer.values(), ...byAddress.values()];
  }

  /**
   * 基于活跃度记录对候选节点排序：高分优先。
   */
  async sortCandidatesByPriority(candidates: PeerNodeInfo[]): Promise<PeerNodeInfo[]> {
    const records = await this.listAll();
    const scoreByPeerId = new Map(records.map((item) => [item.peerId, this.computePriority(item)]));

    return [...candidates].sort((a, b) => {
      const aPeer = this.extractPeerId(a);
      const bPeer = this.extractPeerId(b);
      const aScore = aPeer ? (scoreByPeerId.get(aPeer) ?? Number.MIN_SAFE_INTEGER) : Number.MIN_SAFE_INTEGER;
      const bScore = bPeer ? (scoreByPeerId.get(bPeer) ?? Number.MIN_SAFE_INTEGER) : Number.MIN_SAFE_INTEGER;
      return bScore - aScore;
    });
  }
}
