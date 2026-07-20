/**
 * 组织邀请码（设计：以邀请人为引导节点，将公共引导设施需求降到最低）
 *
 * 邀请码仅携带组织标识与邀请人节点地址，经线下渠道（微信/当面）传播。
 * 它不是 capability：不签名、不含密钥——加入校验发生在拉取侧
 * （被邀请人必须已被管理员预录为成员，见 org-pull-sync 的成员校验）。
 */

export interface OrgInvitePayload {
  type: 'spark-org-invite';
  version: 1;
  orgId: string;
  orgName: string;
  inviter: {
    rootId: string;
    peerId?: string;
    addresses: string[];
  };
  createdAt: number;
}

/**
 * 邀请码接受侧有效期（24 小时）。
 * 邀请码经线下渠道传递、仅作一次性引导入口；过期后管理员重新生成即可，
 * 以此限制历史邀请码泄露后的可用窗口（成员身份校验不受此影响，始终在拉取侧完成）。
 */
export const ORG_INVITE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function encodeOrgInvite(payload: OrgInvitePayload): string {
  return toBase64Url(JSON.stringify(payload));
}

/** 解析并严格校验邀请码；任何字段不符都抛出中文可读错误 */
export function decodeOrgInvite(text: string): OrgInvitePayload {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error('邀请码为空');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(fromBase64Url(trimmed));
  } catch {
    throw new Error('邀请码格式不正确');
  }

  if (parsed?.type !== 'spark-org-invite' || parsed?.version !== 1) {
    throw new Error('不是有效的星火组织邀请码');
  }
  if (typeof parsed.orgId !== 'string' || !parsed.orgId.trim()) {
    throw new Error('邀请码缺少组织标识');
  }
  const inviter = parsed.inviter;
  if (!inviter || typeof inviter.rootId !== 'string' || !/^[0-9a-f]{64}$/.test(inviter.rootId.trim().toLowerCase())) {
    throw new Error('邀请码缺少有效的邀请人身份');
  }
  const addresses = Array.isArray(inviter.addresses)
    ? inviter.addresses.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const peerId = typeof inviter.peerId === 'string' && inviter.peerId.trim() ? inviter.peerId.trim() : undefined;
  if (!peerId && addresses.length === 0) {
    throw new Error('邀请码缺少邀请人的节点地址，无法建立连接');
  }

  // 新鲜度校验放在结构校验之后：格式错误优先报格式问题
  const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : 0;
  if (createdAt <= 0 || Date.now() - createdAt > ORG_INVITE_MAX_AGE_MS) {
    throw new Error('邀请码已过期，请让管理员重新生成');
  }

  return {
    type: 'spark-org-invite',
    version: 1,
    orgId: parsed.orgId.trim(),
    orgName: typeof parsed.orgName === 'string' ? parsed.orgName : '',
    inviter: { rootId: inviter.rootId.trim().toLowerCase(), peerId, addresses },
    createdAt
  };
}
