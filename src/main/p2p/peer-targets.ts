import type { PeerNodeInfo } from './types';

/**
 * 将 libp2p 返回的 peer 列表标准化为字符串数组。
 * 输入可能是字符串、PeerId 实例或其他对象，这里统一调用 toString()。
 */
export function normalizePeerIdList(items: any[]): string[] {
  return items
    .map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.toString === 'function') return item.toString();
      return '';
    })
    .filter((item) => item.length > 0);
}

/**
 * 提取目标 peerId：
 * 1) 优先使用显式的 nodeInfo.peerId；
 * 2) 回退为从 multiaddr 的 /p2p/<peerId> 尾段解析。
 */
export function extractPeerId(nodeInfo: PeerNodeInfo): string | null {
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

/**
 * 构建拨号地址候选：
 * - 原始地址始终保留；
 * - 若地址缺少 /p2p 段且已知 peerId，自动补全一个候选地址。
 *
 * 这样可兼容“只给 host/port”和“给完整 multiaddr”两种成员配置。
 */
export function buildDialTargets(nodeInfo: PeerNodeInfo): string[] {
  const addresses = nodeInfo.addresses.map((item) => item.trim()).filter((item) => item.length > 0);
  if (addresses.length === 0) {
    throw new Error('Member node addresses are required for p2p connect');
  }

  const targetPeerId = extractPeerId(nodeInfo);
  return addresses.flatMap((address) => {
    const targets = [address];
    if (targetPeerId && !address.includes('/p2p/')) {
      targets.push(`${address.replace(/\/$/, '')}/p2p/${targetPeerId}`);
    }
    return targets;
  });
}
