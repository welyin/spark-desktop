import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { sha256Hex } from '../../main/identity/root-id';
import { buildNodeInfoClaimPayload, verifyNodeInfoClaim, type NodeInfoClaim } from '../../main/organization/node-info-claim';

/** 用真实 Ed25519 密钥对构造签名声明；rootId 与公钥满足 sha256(publicKey) === rootId */
function createSignedClaim(overrides: { nodeInfo?: NodeInfoClaim['nodeInfo']; timestamp?: number } = {}): {
  claim: NodeInfoClaim;
  rootId: string;
  secretKey: Uint8Array;
} {
  const keypair = nacl.sign.keyPair();
  const publicKey = Buffer.from(keypair.publicKey);
  const rootId = sha256Hex(publicKey);
  const unsigned = {
    type: 'spark-node-info-claim' as const,
    version: 1 as const,
    rootId,
    publicKey: publicKey.toString('base64'),
    nodeInfo: overrides.nodeInfo ?? { peerId: 'QmClaimPeerDemo', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] },
    timestamp: overrides.timestamp ?? Date.now()
  };
  const payload = buildNodeInfoClaimPayload(unsigned);
  const signature = nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), keypair.secretKey);
  return {
    claim: { ...unsigned, signature: Buffer.from(signature).toString('base64') },
    rootId,
    secretKey: keypair.secretKey
  };
}

describe('verifyNodeInfoClaim', () => {
  it('accepts a well-formed signed claim', () => {
    const { claim } = createSignedClaim();
    expect(verifyNodeInfoClaim(claim)).toEqual({ ok: true });
  });

  it('rejects malformed claims', () => {
    expect(verifyNodeInfoClaim(null as any).reason).toBe('malformed-claim');
    expect(verifyNodeInfoClaim({ type: 'other' } as any).reason).toBe('malformed-claim');
    const { claim } = createSignedClaim();
    expect(verifyNodeInfoClaim({ ...claim, signature: undefined } as any).reason).toBe('malformed-claim');
  });

  it('rejects stale or future-dated claims', () => {
    const stale = createSignedClaim({ timestamp: Date.now() - 11 * 60 * 1000 });
    expect(verifyNodeInfoClaim(stale.claim).reason).toBe('stale-claim');

    const future = createSignedClaim({ timestamp: Date.now() + 11 * 60 * 1000 });
    expect(verifyNodeInfoClaim(future.claim).reason).toBe('stale-claim');
  });

  it('rejects claims whose public key does not match the root id', () => {
    const { claim, secretKey } = createSignedClaim();
    // 换绑一个格式合法但与公钥不匹配的 rootId，并按新载荷重签（隔离变量）
    const forgedRootId = '0'.repeat(64);
    const unsigned = {
      type: claim.type,
      version: claim.version,
      rootId: forgedRootId,
      publicKey: claim.publicKey,
      nodeInfo: claim.nodeInfo,
      timestamp: claim.timestamp
    };
    const signature = nacl.sign.detached(new Uint8Array(Buffer.from(buildNodeInfoClaimPayload(unsigned), 'utf8')), secretKey);
    const forged = { ...unsigned, signature: Buffer.from(signature).toString('base64') };

    expect(verifyNodeInfoClaim(forged).reason).toBe('public-key-root-mismatch');
  });

  it('rejects claims with tampered node info', () => {
    const { claim } = createSignedClaim();
    const tampered: NodeInfoClaim = {
      ...claim,
      nodeInfo: { peerId: 'QmAttackerPeer', addresses: ['/ip4/10.0.0.1/tcp/15002/ws'] }
    };
    expect(verifyNodeInfoClaim(tampered).reason).toBe('invalid-signature');
  });
});
