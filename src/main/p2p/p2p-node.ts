import crypto from 'crypto';
import type { LevelDB } from '../db/base';
import { getEvidenceHeadHash } from '../db/evidence';
import { DIRECT_ORG_RECOVERY_PROTOCOL, DIRECT_ORG_SHARE_PROTOCOL, DIRECT_PEER_EXCHANGE_PROTOCOL, DIRECT_VERSION_PROTOCOL, NODE_ANNOUNCE_INTERVAL_MS, ORG_META_PREFIX, OVERLAY_DIAL_TARGET, OVERLAY_TICK_DIAL_BUDGET, OVERLAY_TOPIC, P2P_DEFAULT_LISTEN_WS_PORT, P2P_LISTEN_WS_PORT, RECOVERY_COOLDOWN_MS, RECOVERY_TRIGGER_CONSECUTIVE_TICKS } from './constants';
import { getOrCreateLibp2pPrivateKey } from './identity-store';
import { buildWsListenAddrs, normalizePreferredPort, parseWsListenPort, pickListenPort, supportsIpv6 } from './listen-port';
import { NodeAnnounceService } from './node-announce';
import { activeRecoveryTokens, OrgRecoveryService } from './org-recovery';
import type { RecoveryViewEntry } from './org-recovery';
import { OverlayPeerStore } from './overlay-peer-store';
import { PeerActivityStore } from './peer-activity-store';
import { PeerExchangeService } from './peer-exchange';
import { buildDialTargets, extractPeerId, normalizePeerIdList } from './peer-targets';
import { OrgShareSyncService } from './org-share-sync';
import { createPubsubMessageHandler } from './pubsub-message-handler';
import { parseJsonSafely, readStreamAsString, writeStringToStream } from './stream-utils';
import type { LocalP2PNodeInfo, P2PIdentityContext, P2PMessageBody, PeerNodeInfo } from './types';
const runtimeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

type P2PRuntimeOptions = {
  appVersion?: string;
  onPeerVersionObserved?: (version: string, peerId: string) => Promise<void> | void;
  /** 成员节点地址声明处理（邀请码引导回填），由装配层注入 organization 服务 */
  onNodeInfoClaim?: (claim: unknown, context: { remotePeerId?: string }) => Promise<void>;
  /**
   * 构造本机签名节点地址声明（周期性重宣告）。
   * 家用宽带公网 IPv4/IPv6 前缀都会变化：keepalive 反熵拉取时捎带新鲜 claim，
   * 对端管理员落库后经组织快照 gossip 扩散，使成员地址记录跟随 IP 变化自动更新。
   */
  getSelfNodeInfoClaim?: () => Promise<unknown | null>;
  /** 组织恢复视图（org-recovery 协议用）：当前身份所属组织的恢复盐与成员地址 */
  getRecoveryView?: () => Promise<RecoveryViewEntry[]>;
};

/**
 * 构造信封验签公钥（Ed25519 SPKI）。
 * 兼容两种线形：TS 广播的 PEM 与 Rust 内核广播的 SPKI DER base64
 * （PEM 即 DER 的 base64 加头尾；属 Rust 互通桥接，见 code/spec/p2p-messages.md §3.3）。
 */
export function createEnvelopeVerifyKey(pubKey: string): crypto.KeyObject {
  const trimmed = pubKey.trim();
  if (trimmed.includes('-----BEGIN PUBLIC KEY-----')) {
    return crypto.createPublicKey(trimmed);
  }
  const der = Buffer.from(trimmed, 'base64');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * P2P 节点编排器。
 * 职责：
 * - 管理 libp2p 生命周期（start/stop）
 * - 管理本地签名与广播封装
 * - 管理成员连接与活跃度记录
 * - 协调 org-share 服务与 pubsub 消息处理器
 */
export class P2PNode {
  private node: any | null = null;
  private startPromise: Promise<void> | null = null;
  private privateKey: crypto.KeyObject;
  public publicKeyPem: string;
  public nodeId: string = 'local-node';
  private readonly peerActivity: PeerActivityStore;
  private readonly overlayPeers: OverlayPeerStore;
  private readonly peerExchange: PeerExchangeService;
  private readonly nodeAnnounce: NodeAnnounceService;
  private readonly orgRecovery: OrgRecoveryService;
  private readonly getRecoveryView?: () => Promise<RecoveryViewEntry[]>;
  private readonly orgShare: OrgShareSyncService;
  private readonly appVersion: string;
  private readonly onPeerVersionObserved?: (version: string, peerId: string) => Promise<void> | void;
  private readonly getSelfNodeInfoClaim?: () => Promise<unknown | null>;
  private readonly versionProbeInFlight = new Set<string>();
  private overlayExchangeCursor = 0;
  private lastAnnouncedAt = 0;
  private orgDeadTickCount = 0;
  private lastRecoveryQueryAt = 0;
  private listenPort: number | null = null;
  /** 本机 libp2p 私钥（start 时从身份库加载）；libp2p v3 节点实例不再暴露它 */
  private libp2pPrivateKey: any = null;

  constructor(
    private readonly db: LevelDB,
    private readonly identityContext?: P2PIdentityContext,
    runtimeOptions?: P2PRuntimeOptions
  ) {
    this.appVersion = runtimeOptions?.appVersion ?? '0.0.0';
    this.onPeerVersionObserved = runtimeOptions?.onPeerVersionObserved;
    this.getSelfNodeInfoClaim = runtimeOptions?.getSelfNodeInfoClaim;

    this.peerActivity = new PeerActivityStore(this.db, extractPeerId);
    this.overlayPeers = new OverlayPeerStore(this.db);
    this.peerExchange = new PeerExchangeService({
      overlayPeers: this.overlayPeers,
      getNode: () => this.node
    });
    this.nodeAnnounce = new NodeAnnounceService({
      overlayPeers: this.overlayPeers,
      getNode: () => this.node,
      getPrivateKey: () => this.libp2pPrivateKey,
      runtimeImport
    });
    this.getRecoveryView = runtimeOptions?.getRecoveryView;
    this.orgRecovery = new OrgRecoveryService({
      getRecoveryView: runtimeOptions?.getRecoveryView ?? (async () => []),
      getNode: () => this.node
    });
    this.orgShare = new OrgShareSyncService({
      db: this.db,
      identityContext: this.identityContext,
      runtimeImport,
      getNode: () => this.node,
      connectPeer: async (nodeInfo) => this.connectPeer(nodeInfo),
      broadcast: async (topic, body) => this.broadcast(topic, body),
      getTopicSubscribers: (topic) => this.getTopicSubscribers(topic),
      onNodeInfoClaim: runtimeOptions?.onNodeInfoClaim
    });

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  private async getOrCreateLibp2pPrivateKey(): Promise<any> {
    return getOrCreateLibp2pPrivateKey(this.db, runtimeImport);
  }

  private async getPersistedListenPort(): Promise<number> {
    const encoded = await this.db.get(P2P_LISTEN_WS_PORT);
    return normalizePreferredPort(encoded, P2P_DEFAULT_LISTEN_WS_PORT);
  }

  private async persistListenPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port <= 0) {
      return;
    }
    await this.db.put(P2P_LISTEN_WS_PORT, String(port));
    this.listenPort = port;
  }

  private async rememberPeerNodeInfo(nodeInfo: PeerNodeInfo, result: 'success' | 'failure' | 'seen', error?: unknown): Promise<void> {
    await this.peerActivity.rememberNodeInfo(nodeInfo, result, error);
  }

  private async markPeerConnected(peerId: string): Promise<void> {
    await this.peerActivity.markConnected(peerId);
  }

  private async markPeerDisconnected(peerId: string): Promise<void> {
    await this.peerActivity.markDisconnected(peerId);
  }

  private getConnectedRemotePeer(peerId: string): any | null {
    if (!this.node || typeof this.node.getConnections !== 'function') {
      return null;
    }

    const connections = this.node.getConnections();
    if (!Array.isArray(connections)) {
      return null;
    }

    for (const connection of connections) {
      const remotePeer = connection?.remotePeer;
      if (!remotePeer) {
        continue;
      }
      const normalized = typeof remotePeer.toString === 'function' ? remotePeer.toString() : String(remotePeer);
      if (normalized === peerId) {
        return remotePeer;
      }
    }

    return null;
  }

  /** 取某个已连接 peer 的实际远端地址（multiaddr 字符串），用于覆盖网邻居池沉淀。 */
  private getRemoteAddrString(peerId: string): string | null {
    if (!this.node || typeof this.node.getConnections !== 'function') {
      return null;
    }

    const connections = this.node.getConnections();
    if (!Array.isArray(connections)) {
      return null;
    }

    for (const connection of connections) {
      const remotePeer = connection?.remotePeer;
      const normalized = typeof remotePeer?.toString === 'function' ? remotePeer.toString() : String(remotePeer ?? '');
      if (normalized !== peerId) {
        continue;
      }
      const remoteAddr = connection?.remoteAddr;
      const text = typeof remoteAddr?.toString === 'function' ? remoteAddr.toString() : String(remoteAddr ?? '');
      return text.length > 0 ? text : null;
    }

    return null;
  }

  private async observePeerVersionByDirectProtocol(peerId: string): Promise<void> {
    if (!this.node || this.versionProbeInFlight.has(peerId)) {
      return;
    }

    const remotePeer = this.getConnectedRemotePeer(peerId);
    if (!remotePeer) {
      return;
    }

    this.versionProbeInFlight.add(peerId);
    try {
      const opened = await this.node.dialProtocol(remotePeer, DIRECT_VERSION_PROTOCOL);
      const text = await readStreamAsString(opened, 2500);
      const payload = parseJsonSafely(text, 'peer-version-response');
      const version = typeof payload?.appVersion === 'string' ? payload.appVersion.trim() : '';
      if (!version) {
        return;
      }

      if (this.onPeerVersionObserved) {
        await this.onPeerVersionObserved(version, peerId);
      }
    } catch (error) {
      console.warn('[p2p] peer version observe failed', {
        peerId,
        error: String(error)
      });
    } finally {
      this.versionProbeInFlight.delete(peerId);
    }
  }

  /** 获取 topic 订阅者（标准化为字符串 peerId）。 */
  private getTopicSubscribers(topic: string): string[] {
    if (!this.node?.services?.pubsub) {
      return [];
    }
    const pubsub = this.node.services.pubsub as any;
    if (typeof pubsub.getSubscribers !== 'function') {
      return [];
    }
    const subscribers = pubsub.getSubscribers(topic);
    return Array.isArray(subscribers) ? normalizePeerIdList(subscribers) : [];
  }

  /** 获取当前连接中的远端 peer 列表。 */
  private getConnectedPeers(): string[] {
    if (!this.node) {
      return [];
    }
    try {
      const connections = typeof this.node.getConnections === 'function' ? this.node.getConnections() : [];
      if (!Array.isArray(connections)) {
        return [];
      }
      const peers = connections.map((connection: any) => connection?.remotePeer).filter(Boolean);
      return Array.from(new Set(normalizePeerIdList(peers)));
    } catch {
      return [];
    }
  }

  /** 登录后重连组织成员，优先连接活跃度高的节点。 */
  async bootstrapOrganizationNetworkOnLogin(): Promise<{ attempted: number; connected: number }> {
    if (!this.node) {
      throw new Error('p2p node not started');
    }
    // 先挂回组织无关的覆盖网：组织成员地址全部陈旧时，
    // 覆盖网邻居是重回 Spark 网络的第一个抓手
    await this.maintainOverlayNetwork();
    const currentRootId = await this.identityContext?.getCurrentRootId();
    if (!currentRootId) {
      return { attempted: 0, connected: 0 };
    }
    const candidates = await this.peerActivity.collectOrganizationPeerCandidates(currentRootId);
    if (candidates.length === 0) {
      return { attempted: 0, connected: 0 };
    }

    const sorted = await this.peerActivity.sortCandidatesByPriority(candidates);
    // 周期性重宣告自身 nodeInfoClaim：家用宽带公网 IPv4/IPv6 前缀会变化，
    // 每次拉取捎带新鲜签名地址，让对端（管理员）落库后 gossip 扩散新地址
    const nodeInfoClaim = (await this.getSelfNodeInfoClaim?.()) ?? undefined;
    let connected = 0;
    for (const candidate of sorted) {
      try {
        await this.connectPeer(candidate);
        await this.rememberPeerNodeInfo(candidate, 'success');
        await this.orgShare.pullOrganizationsForCurrentRootFromPeer(candidate, { nodeInfoClaim });
        connected += 1;
      } catch (error) {
        await this.rememberPeerNodeInfo(candidate, 'failure', error);
      }
    }

    console.log('[p2p] bootstrap organization network on login', {
      attempted: sorted.length,
      connected
    });

    return {
      attempted: sorted.length,
      connected
    };
  }

  /**
   * 覆盖网保活：
   * 1) 活跃连接低于目标时，从组织无关的邻居池补充拨号（组织全灭时此步仍执行）；
   * 2) 每 tick 与一个活跃邻居做 peer-exchange，让邻居来源沿覆盖网持续扩散；
   * 3) 到周期后对外发布签名 node-announce，让最新地址沿覆盖网流动。
   */
  async maintainOverlayNetwork(): Promise<{ overlayDialed: number; exchanged: number; announced: boolean }> {
    if (!this.node) {
      return { overlayDialed: 0, exchanged: 0, announced: false };
    }
    const connectedPeers = new Set(this.getConnectedPeers());
    const shortfall = OVERLAY_DIAL_TARGET - connectedPeers.size;

    let overlayDialed = 0;
    if (shortfall > 0) {
      const budget = Math.min(OVERLAY_TICK_DIAL_BUDGET, shortfall);
      const candidates = await this.overlayPeers.sampleDialCandidates(
        new Set([...connectedPeers, this.nodeId]),
        budget
      );

      for (const candidate of candidates) {
        try {
          await this.connectPeer({ peerId: candidate.peerId, addresses: candidate.addresses });
          await this.overlayPeers.markDialResult(candidate.peerId, 'success');
          overlayDialed += 1;
        } catch (error) {
          await this.overlayPeers.markDialResult(candidate.peerId, 'failure');
          console.warn('[p2p][keepalive] overlay dial failed', {
            peerId: candidate.peerId,
            error: String(error)
          });
        }
      }
    }

    const exchanged = await this.exchangePeersWithOneNeighbor();
    const announced = await this.announceIfDue();

    if (overlayDialed > 0 || exchanged > 0 || announced) {
      console.log('[p2p][keepalive] overlay network maintained', { overlayDialed, exchanged, announced });
    }
    return { overlayDialed, exchanged, announced };
  }

  /** 周期性对外通告本机最新地址（间隔由 NODE_ANNOUNCE_INTERVAL_MS 控制）。 */
  private async announceIfDue(): Promise<boolean> {
    if (Date.now() - this.lastAnnouncedAt < NODE_ANNOUNCE_INTERVAL_MS) {
      return false;
    }
    const published = await this.nodeAnnounce.publishOwnAnnounce().catch((error) => {
      console.warn('[p2p][overlay] periodic announce failed', { error: String(error) });
      return false;
    });
    if (published) {
      this.lastAnnouncedAt = Date.now();
    }
    return published;
  }

  /** 每 tick 轮选一个活跃邻居发起 peer-exchange（游标轮转，避免总是打同一个）。 */
  private async exchangePeersWithOneNeighbor(): Promise<number> {
    const neighbors = this.getConnectedPeers()
      .filter((peerId) => peerId !== this.nodeId)
      .sort();
    if (neighbors.length === 0) {
      return 0;
    }

    const target = neighbors[this.overlayExchangeCursor % neighbors.length];
    this.overlayExchangeCursor += 1;
    if (!target) {
      return 0;
    }
    return await this.peerExchange.exchangeWithPeer(target);
  }

  /**
   * 保活 tick（由 KeepaliveScheduler 周期调用）：
   * 0) 覆盖网维护：活跃连接不足时从组织无关邻居池补拨（组织全灭时此步仍执行）；
   * 1) 候选拨号：向最多 3 个未连接的组织成员节点发起连接；
   * 2) 反熵拉取：从最多 2 个已连接候选拉取组织数据；
   * 3) 管理员补副本：副本数不足 K 时向未同步成员推送快照（每组织最多 2 个）。
   */
  async maintainOrganizationNetwork(): Promise<{ dialed: number; pulled: number; replicaPushed: number; overlayDialed: number; recoveryDialed: number }> {
    if (!this.node) {
      return { dialed: 0, pulled: 0, replicaPushed: 0, overlayDialed: 0, recoveryDialed: 0 };
    }
    const { overlayDialed } = await this.maintainOverlayNetwork();
    const currentRootId = await this.identityContext?.getCurrentRootId();
    if (!currentRootId) {
      return { dialed: 0, pulled: 0, replicaPushed: 0, overlayDialed, recoveryDialed: 0 };
    }

    const candidates = await this.peerActivity.collectOrganizationPeerCandidates(currentRootId);
    if (candidates.length === 0) {
      // 无任何已知成员地址 = 组织失联的更重形态：除了维持覆盖网，仍尝试定向恢复
      const recoveryDialed = await this.maybeRunOrgRecovery(true);
      return { dialed: 0, pulled: 0, replicaPushed: 0, overlayDialed, recoveryDialed };
    }

    const connectedPeers = new Set(this.getConnectedPeers());
    const sorted = await this.peerActivity.sortCandidatesByPriority(candidates);

    let dialed = 0;
    const connectedCandidates: PeerNodeInfo[] = [];
    for (const candidate of sorted) {
      const peerId = extractPeerId(candidate);
      if (peerId && connectedPeers.has(peerId)) {
        connectedCandidates.push(candidate);
        continue;
      }
      if (dialed >= 3) {
        continue;
      }
      try {
        await this.connectPeer(candidate);
        await this.rememberPeerNodeInfo(candidate, 'success');
        connectedCandidates.push(candidate);
        dialed += 1;
      } catch (error) {
        await this.rememberPeerNodeInfo(candidate, 'failure', error);
      }
    }

    let pulled = 0;
    const nodeInfoClaim = (await this.getSelfNodeInfoClaim?.()) ?? undefined;
    for (const candidate of connectedCandidates) {
      if (pulled >= 2) {
        break;
      }
      try {
        await this.orgShare.pullOrganizationsForCurrentRootFromPeer(candidate, { nodeInfoClaim });
        pulled += 1;
      } catch (error) {
        console.warn('[p2p][keepalive] pull from candidate failed', {
          peerId: candidate.peerId,
          error: String(error)
        });
      }
    }

    const replicaPushed = await this.replenishOrganizationReplicas(currentRootId);
    const recoveryDialed = await this.maybeRunOrgRecovery(connectedCandidates.length === 0);

    if (dialed > 0 || pulled > 0 || replicaPushed > 0) {
      console.log('[p2p][keepalive] maintain organization network', { dialed, pulled, replicaPushed, overlayDialed, recoveryDialed });
    }

    return { dialed, pulled, replicaPushed, overlayDialed, recoveryDialed };
  }

  /**
   * 组织失联时的覆盖网定向恢复：
   * 组织侧"全员不可达"连续 RECOVERY_TRIGGER_CONSECUTIVE_TICKS 个 tick 后，
   * 以恢复盐生成 token 向活跃覆盖网邻居查询（每 10 分钟最多一轮），
   * 命中候选只拨号、不写组织成员表——组织校验仍走既有 pull/claim 链路。
   */
  private async maybeRunOrgRecovery(orgUnreachable: boolean): Promise<number> {
    if (!orgUnreachable) {
      this.orgDeadTickCount = 0;
      return 0;
    }

    this.orgDeadTickCount += 1;
    if (this.orgDeadTickCount < RECOVERY_TRIGGER_CONSECUTIVE_TICKS) {
      return 0;
    }
    if (Date.now() - this.lastRecoveryQueryAt < RECOVERY_COOLDOWN_MS) {
      return 0;
    }

    const view = this.getRecoveryView ? await this.getRecoveryView() : [];
    if (view.length === 0) {
      return 0;
    }
    const neighbors = this.getConnectedPeers().filter((peerId) => peerId !== this.nodeId);
    if (neighbors.length === 0) {
      return 0;
    }

    this.lastRecoveryQueryAt = Date.now();
    let dialedCount = 0;
    const attempted = new Set<string>();
    for (const entry of view.slice(0, 3)) {
      const token = activeRecoveryTokens(entry.orgId, entry.recoverySecret)[0];
      if (!token) {
        continue;
      }
      const found = await this.orgRecovery.queryRecovery(token, neighbors.slice(0, 3));
      for (const candidate of found) {
        const key = candidate.peerId ?? candidate.addresses.join('|');
        if (!key || attempted.has(key) || dialedCount >= 4) {
          continue;
        }
        attempted.add(key);
        try {
          await this.connectPeer(candidate);
          dialedCount += 1;
        } catch {
          // 提示类候选，拨不通静默跳过
        }
      }
    }

    if (dialedCount > 0) {
      console.log('[p2p][keepalive] org recovery query dialed candidates', { dialedCount, queriedOrgs: Math.min(view.length, 3) });
    }
    return dialedCount;
  }

  /** 管理员补副本：对副本不足的组织，向从未同步成功的成员推送快照（每组织最多 2 个）。 */
  private async replenishOrganizationReplicas(currentRootId: string): Promise<number> {
    const rows = await this.db.queryRange({
      prefix: ORG_META_PREFIX,
      start: ORG_META_PREFIX,
      end: `${ORG_META_PREFIX}\xFF`
    });

    let pushed = 0;
    for (const row of rows) {
      let record: any;
      try {
        record = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!record?.orgId || !Array.isArray(record.members)) {
        continue;
      }
      const me = record.members.find((member: any) => member?.rootId === currentRootId);
      if (!me || me.role !== 'admin') {
        continue;
      }

      const overview = await this.orgShare.getOrgSyncOverview(record.orgId);
      if (!overview || overview.syncedPeers >= overview.replicaTarget) {
        continue;
      }

      let pushedForOrg = 0;
      for (const member of overview.members) {
        if (pushedForOrg >= 2) {
          break;
        }
        if (member.isSelf || member.everSynced) {
          continue;
        }
        const recordMember = record.members.find((item: any) => item?.rootId === member.rootId);
        const nodeInfo = recordMember?.nodeInfo;
        const hasNodeInfo = nodeInfo && (nodeInfo.peerId || (Array.isArray(nodeInfo.addresses) && nodeInfo.addresses.length > 0));
        if (!hasNodeInfo) {
          continue;
        }
        try {
          await this.orgShare.syncOrganizationToMember(
            { peerId: nodeInfo.peerId, addresses: nodeInfo.addresses },
            member.rootId,
            record
          );
          pushedForOrg += 1;
          pushed += 1;
        } catch (error) {
          console.warn('[p2p][keepalive] replica push failed', {
            orgId: record.orgId,
            targetRootId: member.rootId,
            error: String(error)
          });
        }
      }
    }

    return pushed;
  }

  /**
   * 启动 libp2p 节点。
   *
   * 启动阶段会：
   * - 补齐 Node18/Electron 所需运行时 polyfill
   * - 创建并启动 libp2p
   * - 注册 peer connect/disconnect 事件
   * - 注册 org-share 直连协议 handler
   * - 订阅 spark-sync 并绑定消息处理器
   */
  async start() {
    if (this.node) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      if (typeof (Promise as any).withResolvers !== 'function') {
        (Promise as any).withResolvers = () => {
          let resolve: (value: unknown) => void;
          let reject: (reason?: unknown) => void;
          const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          });
          return { promise, resolve: resolve!, reject: reject! };
        };
      }

      if (typeof (globalThis as any).CustomEvent === 'undefined') {
        (globalThis as any).CustomEvent = class CustomEvent extends Event {
          detail: unknown;

          constructor(type: string, params: { detail?: unknown } = {}) {
            super(type);
            this.detail = params.detail;
          }
        };
      }

      if (typeof (globalThis as any).crypto === 'undefined') {
        (globalThis as any).crypto = crypto.webcrypto;
      }

      if (typeof (globalThis as any).WebSocket === 'undefined') {
        const wsModule = await runtimeImport('ws');
        (globalThis as any).WebSocket = wsModule.WebSocket ?? wsModule.default ?? wsModule;
      }

      const { createLibp2p } = await runtimeImport('libp2p');
      const { webSockets } = await runtimeImport('@libp2p/websockets');
      const { mplex } = await runtimeImport('@libp2p/mplex');
      const { yamux } = await runtimeImport('@chainsafe/libp2p-yamux');
      const { noise } = await runtimeImport('@chainsafe/libp2p-noise');
      const { mdns } = await runtimeImport('@libp2p/mdns');
      const { gossipsub } = await runtimeImport('@libp2p/gossipsub');
      const { identify } = await runtimeImport('@libp2p/identify');
      const { circuitRelayTransport, circuitRelayServer } = await runtimeImport('@libp2p/circuit-relay-v2');
      const { autoNAT } = await runtimeImport('@libp2p/autonat');
      const { uPnPNAT } = await runtimeImport('@libp2p/upnp-nat');
      const { dcutr } = await runtimeImport('@libp2p/dcutr');
      const libp2pPrivateKey = await this.getOrCreateLibp2pPrivateKey();
      this.libp2pPrivateKey = libp2pPrivateKey;
      const preferredPort = await this.getPersistedListenPort();
      // 双栈监听：IPv6 全球单播可达天然免穿透；OS 禁用 IPv6 时回退 IPv4 单栈。
      // 选端口时按将要实际绑定的栈探测，避免"IPv4 空闲但 IPv6 被占"误判可用
      const ipv6Enabled = await supportsIpv6();
      const selectedPort = await pickListenPort(preferredPort, undefined, ipv6Enabled);
      const listenAddresses = buildWsListenAddrs(selectedPort, ipv6Enabled);

      const createNode = async (addrs: string[]) => createLibp2p({
        privateKey: libp2pPrivateKey,
        addresses: { listen: addrs },
        transports: [
          webSockets(),
          // 中继传输：直连不可达时经组织内节点中转（noise 端到端加密，中继只见密文）；
          // 内置 RelayDiscovery 借 identify 自动发现成员中继并预约，
          // 预约所得 /p2p-circuit 地址自动进入 getMultiaddrs() 随邀请码/声明传播
          circuitRelayTransport()
        ],
        // disconnectThreshold 默认仅 5 条新流/秒：本栈建连初期 identify/gossipsub/
        // version/org-share/AutoNAT 回拨叠加轻松超过，会被 mplex 误判攻击而断连。
        // yamux 为 Rust 内核互通桥接（rust-libp2p 已弃 mplex 仅支持 yamux）：
        // 列表保留 mplex 在前，TS↔TS 协商仍优先 mplex，TS↔Rust 自动落到 yamux
        streamMuxers: [mplex({ disconnectThreshold: 100 }), yamux()],
        connectionEncrypters: [noise()],
        peerDiscovery: [mdns()],
        services: {
          identify: identify(),
          // 可达性探测（UPnP 映射地址需经它确认后才对外公布）
          autonat: autoNAT(),
          // 家用路由器端口映射，失败静默不影响其余链路
          upnp: uPnPNAT(),
          // 打洞：中继连接建立后尝试升级为直连
          dcutr: dcutr(),
          // 每个节点都是潜在中继（不可信、可替换），流量受上限约束
          relay: circuitRelayServer({
            reservations: {
              maxReservations: 15,
              defaultDurationLimit: 2 * 60 * 60 * 1000,
              defaultDataLimit: BigInt(256 * 1024 * 1024)
            }
          }),
          pubsub: gossipsub({
            emitSelf: false,
            allowPublishToZeroTopicPeers: true,
            floodPublish: true
          }) as any
        }
      });

      try {
        this.node = await createNode(listenAddresses);
        await this.node.start();
      } catch (error) {
        // 探测与绑定之间存在竞态（或栈语义差异）：双栈失败时回退 IPv4 单栈，
        // 不能让整个 P2P 节点启动失败
        if (!ipv6Enabled) {
          throw error;
        }
        console.warn('[p2p] dual-stack listen failed, retrying with IPv4 only', { error: String(error) });
        await this.node?.stop().catch(() => {});
        this.node = await createNode(buildWsListenAddrs(selectedPort, false));
        await this.node.start();
      }
      this.nodeId = typeof this.node.peerId?.toString === 'function' ? this.node.peerId.toString() : String(this.node.peerId);
      const startedAddresses = typeof this.node.getMultiaddrs === 'function'
        ? (this.node.getMultiaddrs() as any[])
            .map((addr: any) => (typeof addr?.toString === 'function' ? addr.toString() : String(addr ?? '')))
            .filter((value: string) => value.length > 0)
        : [];
      const actualPort = parseWsListenPort(startedAddresses);
      if (actualPort) {
        await this.persistListenPort(actualPort);
      }

      if (typeof this.node.addEventListener === 'function') {
        this.node.addEventListener('peer:connect', async (event: any) => {
          try {
            const peerId = event?.detail?.toString?.() ?? event?.detail?.remotePeer?.toString?.() ?? 'unknown';
            console.log('[p2p] peer connected', peerId);
            if (peerId !== 'unknown') {
              await this.markPeerConnected(peerId);
              // 任何成功连接都沉淀进覆盖网邻居池（组织无关），
              // 使"曾经连通过"本身成为覆盖网的地基
              const remoteAddr = this.getRemoteAddrString(peerId);
              await this.overlayPeers.remember(peerId, remoteAddr ? [remoteAddr] : [], 'connect');
              void this.observePeerVersionByDirectProtocol(peerId);
            }
          } catch (error) {
            // 停止/关闭阶段的迟到事件落在已关闭的 db 上属预期竞态，静默忽略；
            // 其余异常保留告警，避免掩盖真实处理失败
            if (!String(error).includes('Database is not open')) {
              console.warn('[p2p] peer connect handling failed', error);
            }
          }
        });

        this.node.addEventListener('peer:disconnect', async (event: any) => {
          try {
            const peerId = event?.detail?.toString?.() ?? event?.detail?.remotePeer?.toString?.() ?? 'unknown';
            console.log('[p2p] peer disconnected', peerId);
            if (peerId !== 'unknown') {
              await this.markPeerDisconnected(peerId);
            }
          } catch (error) {
            // 与 connect 处理一致：仅静默关闭竞态，其余异常保留告警
            if (!String(error).includes('Database is not open')) {
              console.warn('[p2p] peer disconnect handling failed', error);
            }
          }
        });
      }

      if (typeof this.node.handle === 'function') {
        this.node.handle(DIRECT_ORG_SHARE_PROTOCOL, async (incoming: any) => {
          await this.orgShare.handleDirectIncoming(incoming);
        });
        console.log('[p2p] direct org-share protocol registered', DIRECT_ORG_SHARE_PROTOCOL);

        this.node.handle(DIRECT_VERSION_PROTOCOL, async (incoming: any) => {
          const response = JSON.stringify({
            type: 'peer-version',
            appVersion: this.appVersion,
            nodeId: this.nodeId,
            timestamp: Date.now()
          });
          await writeStringToStream(incoming, response);
        });
        console.log('[p2p] direct version protocol registered', DIRECT_VERSION_PROTOCOL);

        this.node.handle(DIRECT_PEER_EXCHANGE_PROTOCOL, async (incoming: any) => {
          await this.peerExchange.handleDirectIncoming(incoming);
        });
        console.log('[p2p] direct peer-exchange protocol registered', DIRECT_PEER_EXCHANGE_PROTOCOL);

        this.node.handle(DIRECT_ORG_RECOVERY_PROTOCOL, async (incoming: any) => {
          await this.orgRecovery.handleDirectIncoming(incoming);
        });
        console.log('[p2p] direct org-recovery protocol registered', DIRECT_ORG_RECOVERY_PROTOCOL);
      }

      const syncTopic = 'spark-sync';
      await this.node.services.pubsub.subscribe(syncTopic);
      console.log('[p2p] subscribed topic', syncTopic);

      // 覆盖网控制面主题：node-announce 等网络层消息与业务数据分离传播
      await this.node.services.pubsub.subscribe(OVERLAY_TOPIC);
      console.log('[p2p] subscribed topic', OVERLAY_TOPIC);

      // 地址变化（UPnP 映射、relay 预约、IPv6 前缀轮换等）时立即补发一次通告
      if (typeof this.node.addEventListener === 'function') {
        this.node.addEventListener('self:peer:update', () => {
          void this.nodeAnnounce.publishOwnAnnounce().catch((error) => {
            console.warn('[p2p][overlay] announce on self:peer:update failed', { error: String(error) });
          });
        });
      }

      const handleMessage = createPubsubMessageHandler({
        db: this.db,
        verifySignature: (envelope, pubKeyPem, signatureB64) => this.verifySignature(envelope, pubKeyPem, signatureB64),
        orgShare: this.orgShare,
        broadcast: async (topic, body) => this.broadcast(topic, body)
      });

      // 按主题分流：overlay 主题走网络层通告处理，其余走既有业务处理器
      const handleAnyMessage = async (raw: any) => {
        const topic = raw?.detail?.topic ?? raw?.topic;
        if (topic === OVERLAY_TOPIC) {
          await this.nodeAnnounce.handlePubsubMessage(raw);
          return;
        }
        await handleMessage(raw);
      };

      if (typeof this.node.services.pubsub.on === 'function') {
        this.node.services.pubsub.on('message', handleAnyMessage);
        console.log('[p2p] pubsub message handler bound via on(message)');
      } else if (typeof this.node.services.pubsub.addEventListener === 'function') {
        this.node.services.pubsub.addEventListener('message', handleAnyMessage);
        console.log('[p2p] pubsub message handler bound via addEventListener(message)');
      } else {
        console.warn('[p2p] pubsub message handler binding failed: no supported API');
      }

      console.log('[p2p] node started, peerId=', this.nodeId, 'listenPort=', this.listenPort ?? 'unknown');
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** 停止节点并清理引用。 */
  async stop() {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (!this.node) return;
    await this.node.stop();
    this.node = null;
  }

  /** 节点是否已启动。 */
  isStarted() {
    return !!this.node;
  }

  /**
   * 广播业务消息。
   * 自动填充 version/timestamp/evidenceHeadHash 并附加签名信息。
   */
  async broadcast(topic: string, body: Omit<P2PMessageBody, 'timestamp' | 'pubKey' | 'signature' | 'version'> & { domain: string }) {
    if (!this.node) throw new Error('p2p node not started');
    const envelope: P2PMessageBody = {
      version: '1',
      ...body,
      evidenceHeadHash: await getEvidenceHeadHash(this.db),
      timestamp: Date.now()
    };

    envelope.pubKey = this.publicKeyPem;
    envelope.signature = this.signEnvelope(envelope);

    const payload = Buffer.from(JSON.stringify(envelope));
    await this.node.services.pubsub.publish(topic, payload);
  }

  /** 按候选地址列表拨号连接目标成员。 */
  async connectPeer(nodeInfo: PeerNodeInfo): Promise<void> {
    if (!this.node) throw new Error('p2p node not started');

    const { multiaddr } = await runtimeImport('@multiformats/multiaddr');
    const dialTargets = buildDialTargets(nodeInfo);

    let lastError: unknown = null;
    for (const target of dialTargets) {
      try {
        const targetMultiaddr = multiaddr(target);
        await this.node.dial(targetMultiaddr);
        console.log('[p2p] connected to peer via', target);
        await this.rememberPeerNodeInfo(nodeInfo, 'success');
        const peerId = extractPeerId(nodeInfo);
        if (peerId) {
          void this.observePeerVersionByDirectProtocol(peerId);
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }

    await this.rememberPeerNodeInfo(nodeInfo, 'failure', lastError);
    throw new Error(`Failed to connect peer by provided addresses: ${String(lastError)}`);
  }

  /** 对外组织同步入口（委托给 orgShare 服务）。 */
  async syncOrganizationToMember(nodeInfo: PeerNodeInfo, targetRootId: string, organization: any): Promise<void> {
    await this.orgShare.syncOrganizationToMember(nodeInfo, targetRootId, organization);
  }

  /** 对外组织反熵拉取入口（委托给 orgShare 服务）。 */
  async pullOrganizationsFromPeer(nodeInfo: PeerNodeInfo, extras?: { nodeInfoClaim?: unknown }): Promise<{
    checked: number;
    synced: number;
    removed: number;
    pushAttempted: number;
    pushed: number;
    pulled: number;
    skipped: number;
  }> {
    return await this.orgShare.pullOrganizationsForCurrentRootFromPeer(nodeInfo, extras);
  }

  /** 组织副本概览（K 副本可见，委托给 orgShare 服务）。 */
  async getOrgSyncOverview(orgId: string) {
    return await this.orgShare.getOrgSyncOverview(orgId);
  }

  /** 清空本地保存的节点记录（用于测试页快速重置）。 */
  async clearSavedPeerRecords(): Promise<{ cleared: number }> {
    const cleared = await this.peerActivity.clearAllRecords();
    return { cleared };
  }

  /** 获取用于 UI 诊断展示的节点状态快照。 */
  getLocalNodeInfo(): LocalP2PNodeInfo {
    if (!this.node) {
      return {
        initialized: true,
        started: false,
        peerId: null,
        addresses: [],
        connectedPeers: [],
        sparkSyncSubscribers: []
      };
    }

    const rawMultiaddrs = typeof this.node.getMultiaddrs === 'function' ? this.node.getMultiaddrs() : [];
    const addresses = Array.isArray(rawMultiaddrs)
      ? rawMultiaddrs.map((addr: any) => {
          if (!addr) return '';
          if (typeof addr === 'string') return addr;
          if (typeof addr.toString === 'function') return addr.toString();
          return '';
        }).filter((value: string) => value.length > 0)
      : [];

    return {
      initialized: true,
      started: true,
      peerId: this.nodeId,
      addresses,
      connectedPeers: this.getConnectedPeers(),
      sparkSyncSubscribers: this.getTopicSubscribers('spark-sync')
    };
  }

  /** 生成消息签名。 */
  private signEnvelope(envelope: P2PMessageBody) {
    const copy = { ...envelope, signature: undefined } as any;
    const str = JSON.stringify(copy);
    const sig = crypto.sign(null, Buffer.from(str), this.privateKey);
    return sig.toString('base64');
  }

  /** 校验消息签名。pubKey 兼容 PEM 与 SPKI DER base64（Rust 内核线形）。 */
  private verifySignature(envelope: P2PMessageBody, pubKeyPem: string, signatureB64: string) {
    try {
      const copy = { ...envelope, signature: undefined } as any;
      const str = JSON.stringify(copy);
      const sig = Buffer.from(signatureB64, 'base64');
      const pubKey = createEnvelopeVerifyKey(pubKeyPem);
      return crypto.verify(null, Buffer.from(str), pubKey, sig);
    } catch (err) {
      console.error('[p2p] verifySignature error', err);
      return false;
    }
  }
}
