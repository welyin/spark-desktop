import crypto from 'crypto';
import type { LevelDB } from '../db/base';
import { getEvidenceHeadHash } from '../db/evidence';
import { DIRECT_ORG_SHARE_PROTOCOL, DIRECT_VERSION_PROTOCOL, ORG_META_PREFIX, P2P_DEFAULT_LISTEN_WS_PORT, P2P_LISTEN_WS_PORT } from './constants';
import { getOrCreateLibp2pPrivateKey } from './identity-store';
import { normalizePreferredPort, parseWsListenPort, pickListenPort } from './listen-port';
import { PeerActivityStore } from './peer-activity-store';
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
};

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
  private readonly orgShare: OrgShareSyncService;
  private readonly appVersion: string;
  private readonly onPeerVersionObserved?: (version: string, peerId: string) => Promise<void> | void;
  private readonly versionProbeInFlight = new Set<string>();
  private listenPort: number | null = null;

  constructor(
    private readonly db: LevelDB,
    private readonly identityContext?: P2PIdentityContext,
    runtimeOptions?: P2PRuntimeOptions
  ) {
    this.appVersion = runtimeOptions?.appVersion ?? '0.0.0';
    this.onPeerVersionObserved = runtimeOptions?.onPeerVersionObserved;

    this.peerActivity = new PeerActivityStore(this.db, extractPeerId);
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
    const currentRootId = await this.identityContext?.getCurrentRootId();
    if (!currentRootId) {
      return { attempted: 0, connected: 0 };
    }
    const candidates = await this.peerActivity.collectOrganizationPeerCandidates(currentRootId);
    if (candidates.length === 0) {
      return { attempted: 0, connected: 0 };
    }

    const sorted = await this.peerActivity.sortCandidatesByPriority(candidates);
    let connected = 0;
    for (const candidate of sorted) {
      try {
        await this.connectPeer(candidate);
        await this.rememberPeerNodeInfo(candidate, 'success');
        await this.orgShare.pullOrganizationsForCurrentRootFromPeer(candidate);
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
   * 保活 tick（由 KeepaliveScheduler 周期调用）：
   * 1) 候选拨号：向最多 3 个未连接的组织成员节点发起连接；
   * 2) 反熵拉取：从最多 2 个已连接候选拉取组织数据；
   * 3) 管理员补副本：副本数不足 K 时向未同步成员推送快照（每组织最多 2 个）。
   */
  async maintainOrganizationNetwork(): Promise<{ dialed: number; pulled: number; replicaPushed: number }> {
    if (!this.node) {
      return { dialed: 0, pulled: 0, replicaPushed: 0 };
    }
    const currentRootId = await this.identityContext?.getCurrentRootId();
    if (!currentRootId) {
      return { dialed: 0, pulled: 0, replicaPushed: 0 };
    }

    const candidates = await this.peerActivity.collectOrganizationPeerCandidates(currentRootId);
    if (candidates.length === 0) {
      // 无任何可连接成员（都未回填地址）时，补副本也无的放矢，直接结束
      return { dialed: 0, pulled: 0, replicaPushed: 0 };
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
    for (const candidate of connectedCandidates) {
      if (pulled >= 2) {
        break;
      }
      try {
        await this.orgShare.pullOrganizationsForCurrentRootFromPeer(candidate);
        pulled += 1;
      } catch (error) {
        console.warn('[p2p][keepalive] pull from candidate failed', {
          peerId: candidate.peerId,
          error: String(error)
        });
      }
    }

    const replicaPushed = await this.replenishOrganizationReplicas(currentRootId);

    if (dialed > 0 || pulled > 0 || replicaPushed > 0) {
      console.log('[p2p][keepalive] maintain organization network', { dialed, pulled, replicaPushed });
    }

    return { dialed, pulled, replicaPushed };
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
      const { noise } = await runtimeImport('@chainsafe/libp2p-noise');
      const { mdns } = await runtimeImport('@libp2p/mdns');
      const { gossipsub } = await runtimeImport('@chainsafe/libp2p-gossipsub');
      const { identify } = await runtimeImport('@libp2p/identify');
      const libp2pPrivateKey = await this.getOrCreateLibp2pPrivateKey();
      const preferredPort = await this.getPersistedListenPort();
      const selectedPort = await pickListenPort(preferredPort);
      const listenAddress = selectedPort > 0
        ? `/ip4/0.0.0.0/tcp/${selectedPort}/ws`
        : '/ip4/0.0.0.0/tcp/0/ws';

      this.node = await createLibp2p({
        privateKey: libp2pPrivateKey,
        addresses: { listen: [listenAddress] },
        transports: [webSockets()],
        streamMuxers: [mplex()],
        connectionEncrypters: [noise()],
        peerDiscovery: [mdns()],
        services: {
          identify: identify(),
          pubsub: gossipsub({
            emitSelf: false,
            allowPublishToZeroTopicPeers: true,
            floodPublish: true
          }) as any
        }
      });

      await this.node.start();
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
          const peerId = event?.detail?.toString?.() ?? event?.detail?.remotePeer?.toString?.() ?? 'unknown';
          console.log('[p2p] peer connected', peerId);
          if (peerId !== 'unknown') {
            await this.markPeerConnected(peerId);
            void this.observePeerVersionByDirectProtocol(peerId);
          }
        });

        this.node.addEventListener('peer:disconnect', async (event: any) => {
          const peerId = event?.detail?.toString?.() ?? event?.detail?.remotePeer?.toString?.() ?? 'unknown';
          console.log('[p2p] peer disconnected', peerId);
          if (peerId !== 'unknown') {
            await this.markPeerDisconnected(peerId);
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
      }

      const syncTopic = 'spark-sync';
      await this.node.services.pubsub.subscribe(syncTopic);
      console.log('[p2p] subscribed topic', syncTopic);

      const handleMessage = createPubsubMessageHandler({
        db: this.db,
        verifySignature: (envelope, pubKeyPem, signatureB64) => this.verifySignature(envelope, pubKeyPem, signatureB64),
        orgShare: this.orgShare,
        broadcast: async (topic, body) => this.broadcast(topic, body)
      });

      if (typeof this.node.services.pubsub.on === 'function') {
        this.node.services.pubsub.on('message', handleMessage);
        console.log('[p2p] pubsub message handler bound via on(message)');
      } else if (typeof this.node.services.pubsub.addEventListener === 'function') {
        this.node.services.pubsub.addEventListener('message', handleMessage);
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

  /** 校验消息签名。 */
  private verifySignature(envelope: P2PMessageBody, pubKeyPem: string, signatureB64: string) {
    try {
      const copy = { ...envelope, signature: undefined } as any;
      const str = JSON.stringify(copy);
      const sig = Buffer.from(signatureB64, 'base64');
      const pubKey = crypto.createPublicKey(pubKeyPem);
      return crypto.verify(null, Buffer.from(str), pubKey, sig);
    } catch (err) {
      console.error('[p2p] verifySignature error', err);
      return false;
    }
  }
}
