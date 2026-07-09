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
};

type P2PIdentityContext = {
  getCurrentRootId: () => Promise<string | null>;
};

const runtimeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

let p2pNodeInstance: P2PNode | null = null;

export class P2PNode {
  private node: any | null = null;
  private startPromise: Promise<void> | null = null;
  private privateKey: crypto.KeyObject;
  public publicKeyPem: string;
  public nodeId: string = 'local-node';

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

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
            allowPublishToZeroTopicPeers: true
          }) as any
        }
      });

      // 启动节点
      await this.node.start();
      this.nodeId = typeof this.node.peerId?.toString === 'function' ? this.node.peerId.toString() : String(this.node.peerId);

      // 订阅统一的同步 topic
      const syncTopic = 'spark-sync';
      await this.node.services.pubsub.subscribe(syncTopic);

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
          const targetRootId = parsed.payload?.targetRootId;
          const organization = parsed.payload?.organization;
          if (!targetRootId || !organization?.orgId) {
            console.warn('[p2p][org-share] invalid payload, skip');
            return;
          }

          console.log('[p2p][org-share] received candidate', {
            orgId: organization.orgId,
            targetRootId,
            members: Array.isArray(organization.members) ? organization.members.length : 0
          });

          if (!this.identityContext) {
            console.warn('[p2p][org-share] missing identity context, skip');
            return;
          }

          const currentRootId = await this.identityContext.getCurrentRootId();
          if (!currentRootId || currentRootId !== targetRootId) {
            console.log('[p2p][org-share] target mismatch, skip', {
              currentRootId,
              targetRootId
            });
            return;
          }

          const members = Array.isArray(organization.members) ? organization.members : [];
          const containsCurrent = members.some((member: any) => member?.rootId === currentRootId);
          if (!containsCurrent) {
            console.warn('[p2p][org-share] current root not found in members, skip', {
              currentRootId,
              orgId: organization.orgId
            });
            return;
          }

          await this.db.open();
          await this.db.put(`org:meta:${organization.orgId}`, JSON.stringify(organization));
          const persisted = await this.db.get(`org:meta:${organization.orgId}`);
          console.log('[p2p][org-share] organization synced from peer', {
            orgId: organization.orgId,
            persisted: !!persisted,
            memberCount: members.length
          });
        }

        console.log('[p2p] received', parsed.type, 'domain=', parsed.domain);
      } catch (err) {
        console.error('[p2p] failed to handle message', err);
      }
    };

      // 处理入站消息（兼容 EventTarget 与 EventEmitter 两种接口）
      if (typeof this.node.services.pubsub.addEventListener === 'function') {
        this.node.services.pubsub.addEventListener('message', handleMessage);
      } else if (typeof this.node.services.pubsub.on === 'function') {
        this.node.services.pubsub.on('message', handleMessage);
      }

      console.log('[p2p] node started, peerId=', this.nodeId);
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop() {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (!this.node) return;
    await this.node.stop();
    this.node = null;
  }

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

  async connectPeer(nodeInfo: PeerNodeInfo): Promise<void> {
    if (!this.node) throw new Error('p2p node not started');

    const { multiaddr } = await runtimeImport('@multiformats/multiaddr');
    const addresses = nodeInfo.addresses.map((item) => item.trim()).filter((item) => item.length > 0);
    if (addresses.length === 0) {
      throw new Error('Member node addresses are required for p2p connect');
    }

    const dialTargets = addresses.flatMap((address) => {
      const targets = [address];
      if (nodeInfo.peerId && !address.includes('/p2p/')) {
        targets.push(`${address.replace(/\/$/, '')}/p2p/${nodeInfo.peerId}`);
      }
      return targets;
    });

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

  async syncOrganizationToMember(nodeInfo: PeerNodeInfo, targetRootId: string, organization: any): Promise<void> {
    if (!this.node) throw new Error('p2p node not started');
    console.log('[p2p][org-share] start sync to member', {
      orgId: organization?.orgId,
      targetRootId,
      peerId: nodeInfo.peerId,
      addresses: nodeInfo.addresses
    });

    await this.connectPeer(nodeInfo);

    const payload = {
      type: 'org-share',
      domain: 'system',
      payload: {
        targetRootId,
        organization,
        nodeInfo: {
          peerId: nodeInfo.peerId,
          addresses: nodeInfo.addresses
        }
      }
    } as const;

    // gossipsub 在刚建立连接后可能存在短暂传播窗口，增加小次数重试提升送达率。
    const retryIntervalsMs = [0, 250, 750];
    for (let i = 0; i < retryIntervalsMs.length; i += 1) {
      const waitMs = retryIntervalsMs[i];
      if (waitMs > 0) {
        await this.delay(waitMs);
      }
      await this.broadcast('spark-sync', payload);
      console.log('[p2p][org-share] published', {
        orgId: organization?.orgId,
        targetRootId,
        attempt: i + 1,
        total: retryIntervalsMs.length,
        waitMs
      });
    }
  }

  getLocalNodeInfo(): LocalP2PNodeInfo {
    if (!this.node) {
      return {
        initialized: true,
        started: false,
        peerId: null,
        addresses: []
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
      addresses
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
