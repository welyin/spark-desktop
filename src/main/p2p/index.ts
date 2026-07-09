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
import { verifyAccess } from '../db/domain';
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

let p2pNodeInstance: P2PNode | null = null;

export class P2PNode {
  private node: any | null = null;
  private privateKey: crypto.KeyObject;
  public publicKeyPem: string;
  public nodeId: string = 'local-node';

  constructor(private readonly db: LevelDB) {
    // 使用 ed25519 生成密钥对用于消息签名
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** 初始化并启动 libp2p 节点（动态 require，避免编译时强依赖） */
  async start() {
    if (this.node) return;

    // 延迟加载 libp2p 相关模块，运行时需将依赖安装到项目
    const Libp2p = require('libp2p');
    const Gossip = require('libp2p-gossipsub');
    const Websockets = require('libp2p-websockets');
    const Mplex = require('libp2p-mplex');
    const Noise = require('libp2p-noise');
    const MDNS = require('libp2p-mdns');

    this.node = await Libp2p.create({
      addresses: { listen: ['/ip4/0.0.0.0/tcp/0/ws'] },
      modules: {
        transport: [Websockets],
        streamMuxer: [Mplex],
        connEncryption: [Noise],
        pubsub: Gossip,
        peerDiscovery: [MDNS]
      },
      config: {
        pubsub: {
          enabled: true,
          emitSelf: false
        }
      }
    });

    // 启动节点
    await this.node.start();
    this.nodeId = this.node.peerId.toB58String();

    // 订阅统一的同步 topic
    const syncTopic = 'spark-sync';
    await this.node.pubsub.subscribe(syncTopic);

    // 处理入站消息
    this.node.pubsub.on('message', async (msg: any) => {
      try {
        const data = msg.data ? msg.data.toString() : null;
        if (!data) return;
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

        console.log('[p2p] received', parsed.type, 'domain=', parsed.domain);
      } catch (err) {
        console.error('[p2p] failed to handle message', err);
      }
    });

    console.log('[p2p] node started, peerId=', this.nodeId);
  }

  async stop() {
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
    await this.node.pubsub.publish(topic, payload);
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
export function initP2PNode(db: LevelDB): P2PNode {
  if (p2pNodeInstance) {
    throw new Error('P2P node already initialized. Call initP2PNode only once.');
  }
  p2pNodeInstance = new P2PNode(db);
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
