/**
 * P2P 通信封装（基于 js-libp2p）
 * - 节点初始化（含局域网发现 mDNS / WebSockets）
 * - 使用 gossipsub 进行广播
 * - 提供消息签名/校验（Ed25519）
 * - 提供简单的广播/订阅 API
 *
 * 初始化说明：
 * - 必须通过 initP2PNode(db) 显式初始化并注入数据库依赖
 * - 未初始化时调用 getP2PNode() 会抛出错误
 * - 设计为单例模式，同一进程只允许一个 P2P 节点实例
 */
import crypto from 'crypto';
import { LevelDB } from '../db/base';
import { getEvidenceHeadHash } from '../db/evidence';

declare const require: any;

export type P2PMessageBody = {
  version: string; // 协议版本
  type: 'broadcast' | 'sync' | string;
  domain: string; // 数据所属域
  collection?: string; // 可选集合信息
  id?: string;
  payload: any; // 业务数据
  meta?: any;
  evidenceHeadHash?: string | null;
  timestamp: number;
  pubKey?: string; // 发送方公钥（PEM/base64）
  signature?: string; // 签名（base64）
};

export type PeerNodeInfo = {
  peerId?: string;
  addresses: string[];
};

export type LocalP2PNodeInfo = {
  initialized: boolean;
  started: boolean;
  peerId: string | null;
  addresses: string[];
  connectedPeers: string[];
  sparkSyncSubscribers: string[];
};

type P2PIdentityContext = {
  getCurrentRootId: () => Promise<string | null>;
};

const runtimeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
// 点对点组织同步协议：用于绕过 pubsub mesh 时序不稳定，走 request-response 直连确认。
const DIRECT_ORG_SHARE_PROTOCOL = '/spark/org-share/1.0.0';

let p2pNodeInstance: P2PNode | null = null;

export class P2PNode {
  private node: any | null = null;
  private startPromise: Promise<void> | null = null;
  private privateKey: crypto.KeyObject;
  public publicKeyPem: string;
  public nodeId: string = 'local-node';
  // 发送端等待 org-share-ack 的一次性等待器（key: syncId）。
  private orgShareAckWaiters = new Map<string, () => void>();
  // 处理 ACK 先到、waiter 后注册的竞态缓存。
  private orgShareAckCache = new Set<string>();

  /**
   * 兼容不同 libp2p 版本/中间件的入参形态，解析出可读写 stream。
   */
  private resolveProtocolStream(input: any): any | null {
    const candidates = [
      input,
      input?.stream,
      input?.incomingStream,
      input?.detail,
      input?.detail?.stream,
      input?.detail?.incomingStream
    ];

    for (const candidate of candidates) {
      const hasLegacyIo = candidate?.source && candidate?.sink;
      const hasMessageStreamIo = typeof candidate?.send === 'function' && typeof candidate?.[Symbol.asyncIterator] === 'function';
      if (hasLegacyIo || hasMessageStreamIo) {
        return candidate;
      }
    }

    return null;
  }

  /** 简单延时工具，用于重试节奏控制。 */
  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 将 PeerId 列表标准化为字符串数组。 */
  private normalizePeerIdList(items: any[]): string[] {
    return items
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (typeof item.toString === 'function') return item.toString();
        return '';
      })
      .filter((item) => item.length > 0);
  }

  /** 从节点信息中提取目标 PeerId（优先显式 peerId，其次从 multiaddr 解析）。 */
  private extractPeerId(nodeInfo: PeerNodeInfo): string | null {
    const direct = nodeInfo.peerId?.trim();
    if (direct) {
      return direct;
    }

    for (const address of nodeInfo.addresses) {
      const match = address.match(/\/p2p\/([^/]+)$/);
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  }

  /** 构建拨号目标列表：原始地址 + 自动补全 /p2p/<peerId> 地址。 */
  private buildDialTargets(nodeInfo: PeerNodeInfo): string[] {
    const addresses = nodeInfo.addresses.map((item) => item.trim()).filter((item) => item.length > 0);
    if (addresses.length === 0) {
      throw new Error('Member node addresses are required for p2p connect');
    }

    const targetPeerId = this.extractPeerId(nodeInfo);
    return addresses.flatMap((address) => {
      const targets = [address];
      if (targetPeerId && !address.includes('/p2p/')) {
        targets.push(`${address.replace(/\/$/, '')}/p2p/${targetPeerId}`);
      }
      return targets;
    });
  }

  /** 获取某个 pubsub topic 的当前订阅者列表。 */
  private getTopicSubscribers(topic: string): string[] {
    if (!this.node?.services?.pubsub) {
      return [];
    }
    const pubsub = this.node.services.pubsub as any;
    if (typeof pubsub.getSubscribers !== 'function') {
      return [];
    }

    const subscribers = pubsub.getSubscribers(topic);
    return Array.isArray(subscribers) ? this.normalizePeerIdList(subscribers) : [];
  }

  /** 在限定时间内等待目标 peer 出现在 topic 订阅者中。 */
  private async waitForTopicSubscriber(topic: string, targetPeerId: string | null, timeoutMs: number): Promise<void> {
    if (!targetPeerId) {
      return;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const subscribers = this.getTopicSubscribers(topic);
      if (subscribers.includes(targetPeerId)) {
        console.log('[p2p][org-share] target subscriber ready', {
          topic,
          targetPeerId,
          subscribers
        });
        return;
      }
      await this.delay(200);
    }

    console.warn('[p2p][org-share] target subscriber not ready before timeout', {
      topic,
      targetPeerId,
      subscribers: this.getTopicSubscribers(topic)
    });
  }

  /** 标记指定 syncId 已收到 ACK，唤醒等待方或写入竞态缓存。 */
  private markOrgShareAck(syncId: string): void {
    const done = this.orgShareAckWaiters.get(syncId);
    if (done) {
      done();
      return;
    }
    this.orgShareAckCache.add(syncId);
  }

  /** 等待指定 syncId 的 ACK，在超时前返回是否成功。 */
  private async waitForOrgShareAck(syncId: string, timeoutMs: number): Promise<boolean> {
    if (this.orgShareAckCache.has(syncId)) {
      this.orgShareAckCache.delete(syncId);
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.orgShareAckWaiters.delete(syncId);
        resolve(false);
      }, timeoutMs);

      this.orgShareAckWaiters.set(syncId, () => {
        clearTimeout(timer);
        this.orgShareAckWaiters.delete(syncId);
        resolve(true);
      });
    });
  }

  // 按单帧读取 stream 文本，避免两端都等待 EOF 造成协议死锁。
  private async readStreamAsString(stream: any, timeoutMs = 3000): Promise<string> {
    const resolvedStream = this.resolveProtocolStream(stream);
    if (!resolvedStream) {
      throw new Error('protocol stream is unavailable');
    }

    const iterator = resolvedStream.source?.[Symbol.asyncIterator]?.() ?? resolvedStream[Symbol.asyncIterator]?.();
    if (!iterator) {
      throw new Error('stream source is not iterable');
    }

    const nextPromise = iterator.next();
    const firstChunk = await Promise.race([
      nextPromise,
      new Promise<IteratorResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error('stream read timeout')), timeoutMs);
      })
    ]);

    if (!firstChunk || firstChunk.done || !firstChunk.value) {
      return '';
    }

    return Buffer.from(firstChunk.value).toString('utf8');
  }

  // 向 libp2p stream 写入单次文本帧。
  private async writeStringToStream(stream: any, text: string): Promise<void> {
    const resolvedStream = this.resolveProtocolStream(stream);
    if (!resolvedStream) {
      throw new Error('protocol stream is unavailable');
    }

    const data = Buffer.from(text, 'utf8');

    if (typeof resolvedStream.sink === 'function') {
      await resolvedStream.sink((async function* () {
        yield data;
      })());
      return;
    }

    if (typeof resolvedStream.send === 'function') {
      const writable = resolvedStream.send(data);
      if (!writable && typeof resolvedStream.onDrain === 'function') {
        await resolvedStream.onDrain();
      }
      if (typeof resolvedStream.close === 'function') {
        await resolvedStream.close();
      }
      return;
    }

    throw new Error('protocol stream is not writable');
  }

  // org-share 的统一校验与落库逻辑，供 pubsub 与直连协议复用，避免双路径行为漂移。
  private async applyIncomingOrgShare(payload: any, source: 'pubsub' | 'direct'): Promise<{
    accepted: boolean;
    ackPayload?: {
      syncId?: string;
      orgId: string;
      targetRootId: string;
      receiverRootId: string;
    };
  }> {
    const targetRootId = payload?.targetRootId;
    const organization = payload?.organization;
    const syncId = payload?.syncId;
    if (!targetRootId || !organization?.orgId) {
      console.warn(`[p2p][org-share][${source}] invalid payload, skip`);
      return { accepted: false };
    }

    console.log(`[p2p][org-share][${source}] received candidate`, {
      orgId: organization.orgId,
      syncId,
      targetRootId,
      members: Array.isArray(organization.members) ? organization.members.length : 0
    });

    if (!this.identityContext) {
      console.warn(`[p2p][org-share][${source}] missing identity context, skip`);
      return { accepted: false };
    }

    const currentRootId = await this.identityContext.getCurrentRootId();
    if (!currentRootId || currentRootId !== targetRootId) {
      console.log(`[p2p][org-share][${source}] target mismatch, skip`, {
        currentRootId,
        targetRootId
      });
      return { accepted: false };
    }

    const members = Array.isArray(organization.members) ? organization.members : [];
    const containsCurrent = members.some((member: any) => member?.rootId === currentRootId);
    if (!containsCurrent) {
      console.warn(`[p2p][org-share][${source}] current root not found in members, skip`, {
        currentRootId,
        orgId: organization.orgId
      });
      return { accepted: false };
    }

    await this.db.open();
    await this.db.put(`org:meta:${organization.orgId}`, JSON.stringify(organization));
    const persisted = await this.db.get(`org:meta:${organization.orgId}`);
    console.log(`[p2p][org-share][${source}] organization synced from peer`, {
      orgId: organization.orgId,
      syncId,
      persisted: !!persisted,
      memberCount: members.length
    });

    return {
      accepted: true,
      ackPayload: {
        syncId,
        orgId: organization.orgId,
        targetRootId,
        receiverRootId: currentRootId
      }
    };
  }

  /**
   * 安全解析 JSON 文本，解析失败时返回 null 并打印上下文日志。
   */
  private parseJsonSafely(text: string, context: string): any | null {
    const normalized = text.trim();
    if (normalized.length === 0) {
      return null;
    }

    try {
      return JSON.parse(normalized);
    } catch (error) {
      console.warn(`[p2p][json] invalid ${context}`, {
        preview: normalized.slice(0, 120),
        error: String(error)
      });
      return null;
    }
  }

  // 直连同步优先路径：连接已建立后直接 dialProtocol，拿到同步响应即视为成功。
  private async tryDirectOrgShare(nodeInfo: PeerNodeInfo, payload: { targetRootId: string; syncId: string; organization: any }): Promise<boolean> {
    if (!this.node) {
      return false;
    }

    const { multiaddr } = await runtimeImport('@multiformats/multiaddr');
    const dialTargets = this.buildDialTargets(nodeInfo);
    for (const target of dialTargets) {
      try {
        console.log('[p2p][org-share][direct] dialing protocol', {
          target,
          protocol: DIRECT_ORG_SHARE_PROTOCOL,
          syncId: payload.syncId
        });
        const streamResult = await this.node.dialProtocol(multiaddr(target), DIRECT_ORG_SHARE_PROTOCOL);
        const stream = this.resolveProtocolStream(streamResult);
        if (!stream) {
          console.warn('[p2p][org-share][direct] dialProtocol returned unsupported stream shape', {
            target,
            hasStream: !!streamResult?.stream,
            hasIncomingStream: !!streamResult?.incomingStream,
            keys: streamResult ? Object.keys(streamResult) : []
          });
          continue;
        }
        await this.writeStringToStream(stream, JSON.stringify({ type: 'org-share', payload }));
        const responseText = await this.readStreamAsString(stream, 4000);
        const response = this.parseJsonSafely(responseText, 'direct response') as { ok?: boolean; syncId?: string; reason?: string } | null;
        if (!response) {
          console.warn('[p2p][org-share][direct] empty/invalid response', {
            target,
            syncId: payload.syncId
          });
          continue;
        }
        if (response.ok && response.syncId === payload.syncId) {
          console.log('[p2p][org-share][direct] delivery confirmed by direct response', {
            syncId: payload.syncId,
            orgId: payload.organization?.orgId,
            target
          });
          return true;
        }

        console.warn('[p2p][org-share][direct] response not accepted', {
          target,
          syncId: payload.syncId,
          response
        });
      } catch (error) {
        console.warn('[p2p][org-share][direct] dialProtocol failed', {
          target,
          error: String(error)
        });
      }
    }

    return false;
  }

  /** 创建 P2P 节点实例并初始化本地签名密钥对。 */
  constructor(
    private readonly db: LevelDB,
    private readonly identityContext?: P2PIdentityContext
  ) {
    // 使用 ed25519 生成密钥对用于消息签名
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** 初始化并启动 libp2p 节点（动态 require，避免编译时强依赖） */
  async start() {
    if (this.node) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      // Electron/Node18 环境缺少部分现代运行时能力，补齐后可兼容 libp2p 新栈。
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

      // 延迟加载 libp2p 新栈（ESM），避免主进程启动阶段强耦合。
      const { createLibp2p } = await runtimeImport('libp2p');
      const { webSockets } = await runtimeImport('@libp2p/websockets');
      const { mplex } = await runtimeImport('@libp2p/mplex');
      const { noise } = await runtimeImport('@chainsafe/libp2p-noise');
      const { mdns } = await runtimeImport('@libp2p/mdns');
      const { gossipsub } = await runtimeImport('@chainsafe/libp2p-gossipsub');
      const { identify } = await runtimeImport('@libp2p/identify');

      this.node = await createLibp2p({
        addresses: { listen: ['/ip4/0.0.0.0/tcp/0/ws'] },
        transports: [webSockets()],
        streamMuxers: [mplex()],
        connectionEncrypters: [noise()],
        peerDiscovery: [mdns()],
        services: {
          identify: identify(),
          // @chainsafe/libp2p-gossipsub and libp2p may resolve duplicate interface types in TS;
          // runtime is validated by startup smoke tests.
          pubsub: gossipsub({
            emitSelf: false,
            allowPublishToZeroTopicPeers: true,
            floodPublish: true
          }) as any
        }
      });

      // 启动节点
      await this.node.start();
      this.nodeId = typeof this.node.peerId?.toString === 'function' ? this.node.peerId.toString() : String(this.node.peerId);

      if (typeof this.node.addEventListener === 'function') {
        this.node.addEventListener('peer:connect', (event: any) => {
          const peerId = event?.detail?.toString?.() ?? event?.detail?.remotePeer?.toString?.() ?? 'unknown';
          console.log('[p2p] peer connected', peerId);
        });
        this.node.addEventListener('peer:disconnect', (event: any) => {
          const peerId = event?.detail?.toString?.() ?? event?.detail?.remotePeer?.toString?.() ?? 'unknown';
          console.log('[p2p] peer disconnected', peerId);
        });
      }

      if (typeof this.node.handle === 'function') {
        // 注册直连协议接收端：接收 org-share -> 落库校验 -> 同流返回确认响应。
        this.node.handle(DIRECT_ORG_SHARE_PROTOCOL, async (incoming: any) => {
          const stream = this.resolveProtocolStream(incoming);
          if (!stream) {
            console.error('[p2p][org-share][direct] handler stream missing', {
              hasStream: !!incoming?.stream,
              hasIncomingStream: !!incoming?.incomingStream,
              hasDetailStream: !!incoming?.detail?.stream,
              hasDetailIncomingStream: !!incoming?.detail?.incomingStream,
              keys: incoming ? Object.keys(incoming) : []
            });
            return;
          }

          try {
            const requestText = await this.readStreamAsString(stream, 4000);
            const request = this.parseJsonSafely(requestText, 'direct request') as { type?: string; payload?: any } | null;
            if (!request) {
              await this.writeStringToStream(stream, JSON.stringify({ ok: false, reason: 'empty or invalid json' }));
              return;
            }
            console.log('[p2p][org-share][direct] request received', {
              type: request.type,
              syncId: request.payload?.syncId,
              orgId: request.payload?.organization?.orgId
            });
            if (request.type !== 'org-share') {
              await this.writeStringToStream(stream, JSON.stringify({ ok: false, reason: 'invalid type' }));
              return;
            }

            const result = await this.applyIncomingOrgShare(request.payload, 'direct');
            if (!result.accepted || !result.ackPayload) {
              await this.writeStringToStream(stream, JSON.stringify({ ok: false, reason: 'not accepted' }));
              return;
            }

            await this.writeStringToStream(stream, JSON.stringify({
              ok: true,
              syncId: result.ackPayload.syncId,
              orgId: result.ackPayload.orgId,
              receiverRootId: result.ackPayload.receiverRootId
            }));
            console.log('[p2p][org-share][direct] ack responded', {
              syncId: result.ackPayload.syncId,
              orgId: result.ackPayload.orgId,
              receiverRootId: result.ackPayload.receiverRootId
            });
          } catch (error) {
            console.error('[p2p][org-share][direct] handler failed', error);
            try {
              await this.writeStringToStream(stream, JSON.stringify({ ok: false, reason: String(error) }));
            } catch {
              // ignore response write errors in handler failure path
            }
          }
        });
        console.log('[p2p] direct org-share protocol registered', DIRECT_ORG_SHARE_PROTOCOL);
      }

      // 订阅统一的同步 topic
      const syncTopic = 'spark-sync';
      await this.node.services.pubsub.subscribe(syncTopic);
      console.log('[p2p] subscribed topic', syncTopic);

      const handleMessage = async (raw: any) => {
      const msg = raw?.detail ?? raw;
      const dataBytes = msg?.data;
      const data = dataBytes ? Buffer.from(dataBytes).toString('utf8') : null;
      if (!data) return;

      try {
        const parsed: P2PMessageBody = JSON.parse(data);
        // 校验签名
        if (parsed.pubKey && parsed.signature) {
          const ok = this.verifySignature(parsed, parsed.pubKey, parsed.signature);
          if (!ok) {
            console.warn('[p2p] signature invalid, drop message');
            return;
          }
        }

        // 处理不同类型的同步消息
        if (parsed.type === 'update' || parsed.type === 'delete') {
          // 将变更下发到集合层进行合并
          const domain = parsed.domain;
          const collection = parsed.collection;
          const id = parsed.id;
          const payload = parsed.payload ?? null;
          const meta = parsed.meta;
          if (!domain || !collection || !id || !meta) return;
          // 动态导入集合类以避免循环依赖
          const { DocumentCollection } = require('../db/collection');
          const col = new DocumentCollection(this.db, domain, collection, {});
          const { applyRemoteUpdate } = require('../db/sync');
          await applyRemoteUpdate(this.db, col, domain, collection, id, payload, meta);
          if (parsed.evidenceHeadHash) {
            const localHeadHash = await getEvidenceHeadHash(this.db);
            if (localHeadHash !== parsed.evidenceHeadHash) {
              console.warn('[p2p] evidence head mismatch, peer may have diverged');
            }
          }
        }

        if (parsed.type === 'history-response') {
          // 将历史数据应用到本地
          const domain = parsed.domain;
          const collection = parsed.collection;
          const id = parsed.id;
          const payload = parsed.payload ?? null;
          const meta = parsed.meta ?? null;
          if (!domain || !collection || !id || !meta) return;
          const { DocumentCollection } = require('../db/collection');
          const col = new DocumentCollection(this.db, domain, collection, {});
          const { applyRemoteUpdate } = require('../db/sync');
          await applyRemoteUpdate(this.db, col, domain, collection, id, payload, meta);
        }

        if (parsed.type === 'org-share') {
          const result = await this.applyIncomingOrgShare(parsed.payload, 'pubsub');
          if (result.accepted && result.ackPayload?.syncId) {
            await this.broadcast('spark-sync', {
              type: 'org-share-ack',
              domain: 'system',
              payload: result.ackPayload
            });
            console.log('[p2p][org-share] ack sent', {
              syncId: result.ackPayload.syncId,
              orgId: result.ackPayload.orgId,
              receiverRootId: result.ackPayload.receiverRootId
            });
          }
        }

        if (parsed.type === 'org-share-ack') {
          const syncId = parsed.payload?.syncId;
          if (!syncId) {
            return;
          }
          this.markOrgShareAck(syncId);
          console.log('[p2p][org-share] ack received', {
            syncId,
            orgId: parsed.payload?.orgId,
            receiverRootId: parsed.payload?.receiverRootId
          });
        }

        console.log('[p2p] received', parsed.type, 'domain=', parsed.domain);
      } catch (err) {
        console.error('[p2p] failed to handle message', err);
      }
    };

      // 处理入站消息（优先 EventEmitter，兼容 EventTarget）
      if (typeof this.node.services.pubsub.on === 'function') {
        this.node.services.pubsub.on('message', handleMessage);
        console.log('[p2p] pubsub message handler bound via on(message)');
      } else if (typeof this.node.services.pubsub.addEventListener === 'function') {
        this.node.services.pubsub.addEventListener('message', handleMessage);
        console.log('[p2p] pubsub message handler bound via addEventListener(message)');
      } else {
        console.warn('[p2p] pubsub message handler binding failed: no supported API');
      }

      console.log('[p2p] node started, peerId=', this.nodeId);
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** 读取当前已建立连接的远端 peer 列表。 */
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
      return Array.from(new Set(this.normalizePeerIdList(peers)));
    } catch {
      return [];
    }
  }
  /** 停止 p2p 节点。 */
  async stop() {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (!this.node) return;
    await this.node.stop();
    this.node = null;
  }

  /** 返回节点是否已处于启动态。 */
  isStarted() {
    return !!this.node;
  }

  /** 广播消息到指定 topic（会自动签名） */
  async broadcast(topic: string, body: Omit<P2PMessageBody, 'timestamp' | 'pubKey' | 'signature' | 'version'> & { domain: string }) {
    if (!this.node) throw new Error('p2p node not started');
    const envelope: P2PMessageBody = {
      version: '1',
      ...body,
      evidenceHeadHash: await getEvidenceHeadHash(this.db),
      timestamp: Date.now()
    };

    // 自动附加公钥与签名
    envelope.pubKey = this.publicKeyPem;
    envelope.signature = this.signEnvelope(envelope);

    const payload = Buffer.from(JSON.stringify(envelope));
    await this.node.services.pubsub.publish(topic, payload);
  }

  /** 按成员节点信息尝试建立 p2p 连接。 */
  async connectPeer(nodeInfo: PeerNodeInfo): Promise<void> {
    if (!this.node) throw new Error('p2p node not started');

    const { multiaddr } = await runtimeImport('@multiformats/multiaddr');
    const dialTargets = this.buildDialTargets(nodeInfo);

    let lastError: unknown = null;
    for (const target of dialTargets) {
      try {
        const targetMultiaddr = multiaddr(target);
        await this.node.dial(targetMultiaddr);
        console.log('[p2p] connected to peer via', target);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Failed to connect peer by provided addresses: ${String(lastError)}`);
  }

  /** 将组织同步给目标成员（直连优先，pubsub 兜底，ACK 确认成功）。 */
  async syncOrganizationToMember(nodeInfo: PeerNodeInfo, targetRootId: string, organization: any): Promise<void> {
    if (!this.node) throw new Error('p2p node not started');
    const syncTopic = 'spark-sync';
    const syncId = crypto.randomBytes(12).toString('hex');
    const targetPeerId = this.extractPeerId(nodeInfo);
    console.log('[p2p][org-share] start sync to member', {
      orgId: organization?.orgId,
      syncId,
      targetRootId,
      peerId: targetPeerId,
      addresses: nodeInfo.addresses
    });

    await this.connectPeer(nodeInfo);
    await this.waitForTopicSubscriber(syncTopic, targetPeerId, 5000);
    console.log('[p2p][org-share] publishing with subscriber snapshot', {
      topic: syncTopic,
      targetPeerId,
      subscribers: this.getTopicSubscribers(syncTopic)
    });

    const payload = {
      type: 'org-share',
      domain: 'system',
      payload: {
        targetRootId,
        syncId,
        organization,
        nodeInfo: {
          peerId: nodeInfo.peerId,
          addresses: nodeInfo.addresses
        }
      }
    } as const;

    // 优先尝试直连同步，若成功则无需进入 pubsub 重试链路。
    const directDelivered = await this.tryDirectOrgShare(nodeInfo, payload.payload);
    if (directDelivered) {
      this.markOrgShareAck(syncId);
      return;
    }

    // pubsub 兜底：在 mesh 传播窗口内做短间隔重试，并以 ACK 为最终成功条件。
    const retryIntervalsMs = [0, 400, 1000, 2000, 3500];
    for (let i = 0; i < retryIntervalsMs.length; i += 1) {
      const waitMs = retryIntervalsMs[i];
      if (waitMs > 0) {
        await this.delay(waitMs);
      }
      await this.broadcast(syncTopic, payload);
      console.log('[p2p][org-share] published', {
        orgId: organization?.orgId,
        syncId,
        targetRootId,
        attempt: i + 1,
        total: retryIntervalsMs.length,
        waitMs
      });

      const acked = await this.waitForOrgShareAck(syncId, 1500);
      if (acked) {
        console.log('[p2p][org-share] delivery confirmed by ack', {
          syncId,
          orgId: organization?.orgId,
          targetRootId,
          attempt: i + 1
        });
        return;
      }

      console.warn('[p2p][org-share] ack timeout for attempt', {
        syncId,
        orgId: organization?.orgId,
        targetRootId,
        attempt: i + 1
      });
    }

    throw new Error(`Organization sync ack timeout: orgId=${organization?.orgId}, targetRootId=${targetRootId}, syncId=${syncId}`);
  }

  /** 获取本地节点可观测信息（地址、连接、订阅者等）。 */
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

  /** 使用本地私钥签名信封（签名前去除 signature 字段） */
  private signEnvelope(envelope: P2PMessageBody) {
    const copy = { ...envelope, signature: undefined } as any;
    const str = JSON.stringify(copy);
    const sig = crypto.sign(null, Buffer.from(str), this.privateKey);
    return sig.toString('base64');
  }

  /** 验证签名 */
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

/**
 * 初始化 P2P 节点单例，注入数据库依赖
 * 必须在使用 getP2PNode() 之前调用
 */
export function initP2PNode(db: LevelDB, identityContext?: P2PIdentityContext): P2PNode {
  if (p2pNodeInstance) {
    throw new Error('P2P node already initialized. Call initP2PNode only once.');
  }
  p2pNodeInstance = new P2PNode(db, identityContext);
  return p2pNodeInstance;
}

/**
 * 获取已初始化的 P2P 节点单例
 * @throws 如果尚未调用 initP2PNode 初始化
 */
export function getP2PNode(): P2PNode {
  if (!p2pNodeInstance) {
    throw new Error('P2P node not initialized. Call initP2PNode(db) first.');
  }
  return p2pNodeInstance;
}

/**
 * 检查 P2P 节点是否已初始化
 */
export function isP2PInitialized(): boolean {
  return p2pNodeInstance !== null;
}
