import nacl from 'tweetnacl';
import { NODE_ANNOUNCE_ACCEPT_MIN_INTERVAL_MS, NODE_ANNOUNCE_MAX_AGE_MS, OVERLAY_TOPIC } from './constants';
import type { OverlayPeerStore } from './overlay-peer-store';

/**
 * 节点网络层通告（node-announce）
 *
 * 作用：让节点的最新地址沿覆盖网持续流动，而不是只在组织同步链路里回填。
 * 与 nodeInfoClaim 的区别：
 * - 用 libp2p 节点私钥签名（证明"该 peerId 持有者发布了这些地址"），
 *   不携带 rootId/根公钥，避免把组织身份泄露给覆盖网上的陌生节点；
 * - 只在 OVERLAY_TOPIC 控制面主题传播，与业务数据主题分离；
 * - 接收方验签通过后才把地址标记为 verified 入池。
 */

/** 单条 announce 允许的地址数量与单地址长度上限（防放大与畸形负载） */
const MAX_ANNOUNCE_ADDRESSES = 20;
const MAX_ANNOUNCE_ADDRESS_LENGTH = 512;

export type NodeAnnounce = {
  type: 'spark-node-announce';
  version: 1;
  peerId: string;
  addresses: string[];
  timestamp: number;
  signature: string;
};

/** 待签名载荷（固定键序保证两端一致） */
export function buildNodeAnnouncePayload(announce: Omit<NodeAnnounce, 'signature'>): string {
  return JSON.stringify({
    type: announce.type,
    version: announce.version,
    peerId: announce.peerId,
    addresses: announce.addresses,
    timestamp: announce.timestamp
  });
}

function isNodeAnnounce(value: any): value is NodeAnnounce {
  return (
    Boolean(value) &&
    value.type === 'spark-node-announce' &&
    value.version === 1 &&
    typeof value.peerId === 'string' &&
    Array.isArray(value.addresses) &&
    value.addresses.every((item: unknown) => typeof item === 'string') &&
    typeof value.timestamp === 'number' &&
    typeof value.signature === 'string'
  );
}

type NodeAnnounceDeps = {
  overlayPeers: OverlayPeerStore;
  getNode: () => any;
  /**
   * 取本机 libp2p 私钥（@libp2p/crypto PrivateKey）。
   * libp2p v3 起节点实例不再暴露 privateKey，必须由装配层显式提供。
   */
  getPrivateKey: () => any;
  runtimeImport: (specifier: string) => Promise<any>;
};

export class NodeAnnounceService {
  private readonly lastAcceptedAtByPeerId = new Map<string, number>();

  constructor(private readonly deps: NodeAnnounceDeps) {}

  /** 发布本机地址通告；节点未启动或无可用地址时返回 false。 */
  async publishOwnAnnounce(): Promise<boolean> {
    const node = this.deps.getNode();
    const privateKey = this.deps.getPrivateKey();
    if (!node || !privateKey || typeof node.peerId?.toString !== 'function') {
      return false;
    }

    const addresses = (typeof node.getMultiaddrs === 'function' ? node.getMultiaddrs() : [])
      .map((addr: any) => (typeof addr?.toString === 'function' ? addr.toString() : String(addr ?? '')))
      .filter((value: string) => value.length > 0 && value.length <= MAX_ANNOUNCE_ADDRESS_LENGTH)
      .slice(0, MAX_ANNOUNCE_ADDRESSES);
    if (addresses.length === 0) {
      return false;
    }

    const unsigned = {
      type: 'spark-node-announce' as const,
      version: 1 as const,
      peerId: node.peerId.toString(),
      addresses,
      timestamp: Date.now()
    };
    // 优先用 tweetnacl + 原始私钥签名：Ed25519 是确定性签名，输出与
    // privateKey.sign 逐字节一致（已在纯 node 下验证），但可规避多 realm
    // 环境下 @noble 内部 instanceof 检查导致的签名异常
    const payloadBytes = Buffer.from(buildNodeAnnouncePayload(unsigned), 'utf8');
    const rawSecretKey = privateKey?.raw;
    const signatureBytes = rawSecretKey && rawSecretKey.length === nacl.sign.secretKeyLength
      ? nacl.sign.detached(new Uint8Array(payloadBytes), new Uint8Array(rawSecretKey))
      : await privateKey.sign(payloadBytes);
    const message = JSON.stringify({ ...unsigned, signature: Buffer.from(signatureBytes).toString('base64') });

    await node.services.pubsub.publish(OVERLAY_TOPIC, Buffer.from(message, 'utf8'));
    console.log('[p2p][overlay] node announce published', { peerId: unsigned.peerId, addresses: addresses.length });
    return true;
  }

  /**
   * 处理 OVERLAY_TOPIC 上的入站消息。
   * 验签通过且未触发限流时，地址以 verified 身份入池；其余情况静默丢弃。
   */
  async handlePubsubMessage(raw: any): Promise<boolean> {
    const msg = raw?.detail ?? raw;
    const dataBytes = msg?.data;
    const data = dataBytes ? Buffer.from(dataBytes).toString('utf8') : null;
    if (!data) {
      return false;
    }

    let announce: NodeAnnounce;
    try {
      announce = JSON.parse(data);
    } catch {
      return false;
    }
    if (!isNodeAnnounce(announce)) {
      return false;
    }

    if (Math.abs(Date.now() - announce.timestamp) > NODE_ANNOUNCE_MAX_AGE_MS) {
      return false;
    }

    if (announce.addresses.length === 0 || announce.addresses.length > MAX_ANNOUNCE_ADDRESSES) {
      return false;
    }
    if (announce.addresses.some((item) => item.length === 0 || item.length > MAX_ANNOUNCE_ADDRESS_LENGTH)) {
      return false;
    }

    // 自身通告不回池（gossipsub emitSelf=false 时本就不会收到，此处为防御）
    const node = this.deps.getNode();
    const selfPeerId = typeof node?.peerId?.toString === 'function' ? node.peerId.toString() : '';
    if (announce.peerId === selfPeerId) {
      return false;
    }

    if (!this.checkAcceptRateLimit(announce.peerId)) {
      return false;
    }

    if (!(await this.verifySignature(announce))) {
      return false;
    }

    await this.deps.overlayPeers.remember(announce.peerId, announce.addresses, 'announce', true);
    return true;
  }

  /** 同一 peerId 两次接受的最小间隔（防刷） */
  private checkAcceptRateLimit(peerId: string): boolean {
    const now = Date.now();
    const lastAcceptedAt = this.lastAcceptedAtByPeerId.get(peerId) ?? 0;
    if (now - lastAcceptedAt < NODE_ANNOUNCE_ACCEPT_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastAcceptedAtByPeerId.set(peerId, now);
    return true;
  }

  /** 用 peerId 内嵌的 Ed25519 公钥验签（不依赖任何预交换材料）。 */
  private async verifySignature(announce: NodeAnnounce): Promise<boolean> {
    try {
      const { peerIdFromString } = await this.deps.runtimeImport('@libp2p/peer-id');
      const peerId = peerIdFromString(announce.peerId);
      const rawPublicKey = peerId?.publicKey?.raw;
      if (!rawPublicKey || rawPublicKey.length !== nacl.sign.publicKeyLength) {
        return false;
      }

      const payload = buildNodeAnnouncePayload({
        type: announce.type,
        version: announce.version,
        peerId: announce.peerId,
        addresses: announce.addresses,
        timestamp: announce.timestamp
      });
      const signature = Buffer.from(announce.signature, 'base64');
      if (signature.length !== nacl.sign.signatureLength) {
        return false;
      }

      // new Uint8Array(...) 复制到本 realm：规避测试/打包多 realm 下
      // 跨 realm instanceof 误判（与 root-id.ts 的验签口径一致，用 tweetnacl）
      return nacl.sign.detached.verify(
        new Uint8Array(Buffer.from(payload, 'utf8')),
        new Uint8Array(signature),
        new Uint8Array(rawPublicKey)
      );
    } catch {
      return false;
    }
  }
}
