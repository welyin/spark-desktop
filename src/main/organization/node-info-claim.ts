import { sha256Hex, verifyEd25519Signature } from '../identity/root-id';
import type { OrganizationNodeInfo } from './types';

/**
 * 成员节点信息声明（nodeInfoClaim）
 *
 * 成员加入组织后，需要把自己的节点地址告知其他成员（否则无人能与它建立连接）。
 * 声明随 pull 请求捎带给邀请人/管理员节点，由管理员校验后写入成员记录并随组织快照传播。
 *
 * 防伪绑定：声明携带根公钥与签名，校验方用 sha256(publicKey) === rootId 自包含地
 * 确认"签名者就是该 rootId 持有者"，无需任何 PKI 或事先交换公钥。
 */

export const NODE_INFO_CLAIM_MAX_AGE_MS = 10 * 60 * 1000;

export type NodeInfoClaim = {
  type: 'spark-node-info-claim';
  version: 1;
  rootId: string;
  publicKey: string;
  nodeInfo: OrganizationNodeInfo;
  timestamp: number;
  signature: string;
};

/** 待签名载荷（固定键序保证两端一致） */
export function buildNodeInfoClaimPayload(claim: Omit<NodeInfoClaim, 'signature'>): string {
  return JSON.stringify({
    type: claim.type,
    version: claim.version,
    rootId: claim.rootId,
    publicKey: claim.publicKey,
    nodeInfo: {
      peerId: claim.nodeInfo.peerId ?? null,
      addresses: claim.nodeInfo.addresses
    },
    timestamp: claim.timestamp
  });
}

export function isNodeInfoClaim(value: unknown): value is NodeInfoClaim {
  const claim = value as NodeInfoClaim;
  return (
    Boolean(claim) &&
    claim.type === 'spark-node-info-claim' &&
    claim.version === 1 &&
    typeof claim.rootId === 'string' &&
    typeof claim.publicKey === 'string' &&
    Boolean(claim.nodeInfo) &&
    Array.isArray(claim.nodeInfo.addresses) &&
    typeof claim.timestamp === 'number' &&
    typeof claim.signature === 'string'
  );
}

/**
 * 校验声明（纯函数）：
 * - 结构、时间戳新鲜度（默认 10 分钟内）
 * - sha256(publicKey) === rootId（公钥与身份绑定）
 * - Ed25519 签名有效
 */
export function verifyNodeInfoClaim(
  claim: NodeInfoClaim,
  options: { nowMs?: number; maxAgeMs?: number } = {}
): { ok: boolean; reason?: string } {
  if (!isNodeInfoClaim(claim)) {
    return { ok: false, reason: 'malformed-claim' };
  }

  const now = options.nowMs ?? Date.now();
  const maxAge = options.maxAgeMs ?? NODE_INFO_CLAIM_MAX_AGE_MS;
  if (Math.abs(now - claim.timestamp) > maxAge) {
    return { ok: false, reason: 'stale-claim' };
  }

  const normalizedRootId = claim.rootId.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedRootId)) {
    return { ok: false, reason: 'invalid-root-id' };
  }

  let publicKey: Buffer;
  try {
    publicKey = Buffer.from(claim.publicKey, 'base64');
  } catch {
    return { ok: false, reason: 'invalid-public-key' };
  }
  if (sha256Hex(publicKey) !== normalizedRootId) {
    return { ok: false, reason: 'public-key-root-mismatch' };
  }

  const payload = buildNodeInfoClaimPayload({
    type: claim.type,
    version: claim.version,
    rootId: claim.rootId,
    publicKey: claim.publicKey,
    nodeInfo: claim.nodeInfo,
    timestamp: claim.timestamp
  });
  if (!verifyEd25519Signature(payload, claim.signature, claim.publicKey)) {
    return { ok: false, reason: 'invalid-signature' };
  }

  return { ok: true };
}
