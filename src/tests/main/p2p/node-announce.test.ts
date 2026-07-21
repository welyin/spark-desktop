import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { NODE_ANNOUNCE_MAX_AGE_MS, OVERLAY_TOPIC } from '../../../main/p2p/constants';
import { buildNodeAnnouncePayload, NodeAnnounceService } from '../../../main/p2p/node-announce';
import { OverlayPeerStore } from '../../../main/p2p/overlay-peer-store';
import { P2PNode } from '../../../main/p2p/p2p-node';

class MemoryDb {
  private readonly store = new Map<string, string>();

  async open(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async queryRange(options: { prefix: string; start?: string; end?: string }): Promise<Array<{ key: string; value: string }>> {
    return [...this.store.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
  }
}

const runtimeImport = async (specifier: string) => await import(specifier);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 极简 base58 编码（构造 peerId 字符串用，避免引入额外依赖） */
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = ((digits[index] ?? 0) << 8) + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = '';
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    output += BASE58_ALPHABET[0];
  }
  return output + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('');
}

/**
 * 测试身份用 tweetnacl 生成，peerId 手工拼装：
 * base58btc( identity-multihash( protobuf(Ed25519 publicKey) ) )。
 * 注意：不能在 vitest 中用 @libp2p/crypto 的 generateKeyPair——其内部 @noble
 * 在本测试环境下会产出"私钥与内嵌公钥不一致"的坏密钥（纯 node/生产环境正常），
 * 而 tweetnacl 全程纯 JS，无此问题。签名输出与生产路径逐字节一致（Ed25519 确定性签名）。
 */
function makeIdentity() {
  const keypair = nacl.sign.keyPair();
  const protobuf = new Uint8Array(4 + 32);
  protobuf.set([0x08, 0x01, 0x12, 0x20], 0);
  protobuf.set(keypair.publicKey, 4);
  const multihash = new Uint8Array(2 + protobuf.length);
  multihash.set([0x00, 0x24], 0);
  multihash.set(protobuf, 2);
  return {
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    peerIdString: base58Encode(multihash)
  };
}

type TestIdentity = ReturnType<typeof makeIdentity>;

async function signAnnounce(identity: TestIdentity, overrides: Record<string, unknown> = {}) {
  const unsigned = {
    type: 'spark-node-announce' as const,
    version: 1 as const,
    peerId: identity.peerIdString,
    addresses: ['/ip4/1.2.3.4/tcp/15002/ws'],
    timestamp: Date.now(),
    ...overrides
  };
  const signatureBytes = nacl.sign.detached(
    new Uint8Array(Buffer.from(buildNodeAnnouncePayload(unsigned as any), 'utf8')),
    new Uint8Array(identity.secretKey)
  );
  return JSON.stringify({ ...unsigned, signature: Buffer.from(signatureBytes).toString('base64') });
}

function makeService(db: MemoryDb, nodeOverride: any = null, privateKeyOverride: any = null) {
  return new NodeAnnounceService({
    overlayPeers: new OverlayPeerStore(db as any),
    getNode: () => nodeOverride,
    getPrivateKey: () => privateKeyOverride,
    runtimeImport
  });
}

describe('NodeAnnounceService', () => {
  it('publishes a signed announce and a peer accepts it into the pool as verified', async () => {
    const identity = makeIdentity();
    const published: Array<{ topic: string; text: string }> = [];
    const publisherNode = {
      peerId: { toString: () => identity.peerIdString },
      getMultiaddrs: () => [{ toString: () => '/ip4/1.2.3.4/tcp/15002/ws' }],
      services: {
        pubsub: {
          publish: async (topic: string, bytes: Uint8Array) => {
            published.push({ topic, text: Buffer.from(bytes).toString('utf8') });
          }
        }
      }
    };
    // 私钥独立于节点对象注入：libp2p v3 起节点实例不再暴露 privateKey
    const publisher = makeService(new MemoryDb(), publisherNode, { raw: identity.secretKey });

    expect(await publisher.publishOwnAnnounce()).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe(OVERLAY_TOPIC);

    // 私钥缺失（如 libp2p v3 节点不再暴露 privateKey）时必须显式失败，
    // 不能静默退化为未签名发布
    const keyless = makeService(new MemoryDb(), publisherNode, null);
    expect(await keyless.publishOwnAnnounce()).toBe(false);
    expect(published).toHaveLength(1);

    // 另一个节点接收同一条通告
    const receiverDb = new MemoryDb();
    const receiver = makeService(receiverDb, { peerId: { toString: () => 'QmOther' } });
    const accepted = await receiver.handlePubsubMessage({
      detail: { topic: OVERLAY_TOPIC, data: Buffer.from(published[0]!.text, 'utf8') }
    });

    expect(accepted).toBe(true);
    const pool = await new OverlayPeerStore(receiverDb as any).listAll();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.peerId).toBe(identity.peerIdString);
    expect(pool[0]?.verified).toBe(true);
    expect(pool[0]?.source).toBe('announce');
    expect(pool[0]?.addresses).toEqual(['/ip4/1.2.3.4/tcp/15002/ws']);
  });

  it('rejects announces with a tampered signature', async () => {
    const identity = await makeIdentity();
    const message = JSON.parse(await signAnnounce(identity));
    message.signature = Buffer.from('forged-signature').toString('base64');

    const db = new MemoryDb();
    const service = makeService(db, { peerId: { toString: () => 'QmOther' } });
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from(JSON.stringify(message)) } })).toBe(false);
    expect(await new OverlayPeerStore(db as any).listAll()).toHaveLength(0);
  });

  it('rejects announces whose peerId does not match the signing key', async () => {
    const signer = await makeIdentity();
    const other = await makeIdentity();
    // 用 A 的私钥签名，却声称自己是 B
    const message = await signAnnounce(signer, { peerId: other.peerIdString });

    const service = makeService(new MemoryDb(), { peerId: { toString: () => 'QmThird' } });
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from(message) } })).toBe(false);
  });

  it('rejects stale announces', async () => {
    const identity = await makeIdentity();
    const message = await signAnnounce(identity, { timestamp: Date.now() - NODE_ANNOUNCE_MAX_AGE_MS - 60_000 });

    const service = makeService(new MemoryDb(), { peerId: { toString: () => 'QmOther' } });
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from(message) } })).toBe(false);
  });

  it('rate-limits repeated announces from the same peer', async () => {
    const identity = await makeIdentity();
    const service = makeService(new MemoryDb(), { peerId: { toString: () => 'QmOther' } });

    const first = await signAnnounce(identity);
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from(first) } })).toBe(true);

    const second = await signAnnounce(identity);
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from(second) } })).toBe(false);
  });

  it('ignores malformed payloads and self announces', async () => {
    const identity = makeIdentity();
    const service = makeService(new MemoryDb(), { peerId: { toString: () => identity.peerIdString } });

    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from('not-json') } })).toBe(false);
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from('{"type":"other"}') } })).toBe(false);

    const selfMessage = await signAnnounce(identity);
    expect(await service.handlePubsubMessage({ detail: { topic: OVERLAY_TOPIC, data: Buffer.from(selfMessage) } })).toBe(false);
  });
});

describe('P2PNode announce tick wiring', () => {
  it('announces when due and skips when within the interval', async () => {
    const node = new P2PNode(new MemoryDb() as any);
    (node as any).node = {
      getConnections: () => []
    };

    let publishCalls = 0;
    (node as any).nodeAnnounce.publishOwnAnnounce = async () => {
      publishCalls += 1;
      return true;
    };

    const first = await node.maintainOverlayNetwork();
    expect(first.announced).toBe(true);
    expect(publishCalls).toBe(1);

    const second = await node.maintainOverlayNetwork();
    expect(second.announced).toBe(false);
    expect(publishCalls).toBe(1);
  });
});
