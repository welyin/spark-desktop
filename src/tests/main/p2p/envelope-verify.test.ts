import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { createEnvelopeVerifyKey, P2PNode } from '../../../main/p2p/p2p-node';

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

  async queryRange(options: { prefix: string }): Promise<Array<{ key: string; value: string }>> {
    return [...this.store.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
  }
}

/** Ed25519 SPKI DER 前缀（与 Rust 内核 envelope.rs 的 ED25519_SPKI_DER_PREFIX 一致） */
const SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url');
  return { publicKey, privateKey, pem, der, raw };
}

/** 复刻生产签名输入：信封去 signature 后的紧凑 JSON（p2p-node.ts signEnvelope） */
function signEnvelopeLike(privateKey: crypto.KeyObject, envelope: Record<string, unknown>): string {
  const str = JSON.stringify({ ...envelope, signature: undefined });
  return crypto.sign(null, Buffer.from(str), privateKey).toString('base64');
}

describe('createEnvelopeVerifyKey（Rust 互通桥接：PEM / SPKI DER base64 双形态）', () => {
  it('accepts PEM public keys', () => {
    const { pem, publicKey } = makeKeyPair();
    const key = createEnvelopeVerifyKey(pem);
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(key.equals(publicKey)).toBe(true);
  });

  it('accepts SPKI DER base64 public keys (Rust wire form)', () => {
    const { der, publicKey } = makeKeyPair();
    const key = createEnvelopeVerifyKey(der.toString('base64'));
    expect(key.equals(publicKey)).toBe(true);
  });

  it('pins the Rust DER construction: 12-byte prefix + raw 32-byte key', () => {
    const { der, raw } = makeKeyPair();
    expect(raw.length).toBe(32);
    expect(der.length).toBe(44);
    // Rust 侧 spki_der_from_raw 的输出必须与此处逐字节一致
    expect(Buffer.concat([SPKI_DER_PREFIX, raw]).equals(der)).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(() => createEnvelopeVerifyKey('not-a-key')).toThrow();
  });
});

describe('P2PNode.verifySignature with DER base64 pubKey', () => {
  it('verifies an envelope signed by a Rust-style (DER base64) key and rejects tampering', () => {
    const { privateKey, der } = makeKeyPair();
    const node = new P2PNode(new MemoryDb() as any);
    const verify = (envelope: Record<string, unknown>, pubKey: string, signature: string) =>
      (node as any).verifySignature(envelope, pubKey, signature);

    const envelope: Record<string, unknown> = {
      version: '1',
      type: 'update',
      domain: 'notes',
      collection: 'items',
      id: 'doc-1',
      payload: { text: 'hello from rust' },
      meta: { vv: { nodeR: 1 }, ts: 1720000000000, nodeId: '12D3KooWRustPeer' },
      evidenceHeadHash: null,
      timestamp: 1720000000000,
      pubKey: der.toString('base64')
    };
    envelope.signature = signEnvelopeLike(privateKey, envelope);

    expect(verify(envelope, envelope.pubKey as string, envelope.signature as string)).toBe(true);

    // 篡改 payload → 验签失败
    const tampered = { ...envelope, payload: { text: 'forged' } };
    expect(verify(tampered, envelope.pubKey as string, envelope.signature as string)).toBe(false);

    // 非法 pubKey → 返回 false 而不是抛异常
    expect(verify(envelope, '%%%', envelope.signature as string)).toBe(false);
  });

  it('still verifies PEM-signed envelopes (TS↔TS 回归)', () => {
    const { privateKey, pem } = makeKeyPair();
    const node = new P2PNode(new MemoryDb() as any);
    const envelope: Record<string, unknown> = {
      version: '1',
      type: 'delete',
      domain: 'notes',
      collection: 'items',
      id: 'doc-2',
      payload: null,
      meta: { vv: { nodeT: 3 }, ts: 1720000000123, nodeId: '12D3KooWTsPeer' },
      evidenceHeadHash: null,
      timestamp: 1720000000123,
      pubKey: pem
    };
    envelope.signature = signEnvelopeLike(privateKey, envelope);
    expect((node as any).verifySignature(envelope, pem, envelope.signature as string)).toBe(true);
  });
});
