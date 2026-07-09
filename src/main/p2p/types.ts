/**
 * P2P 通道消息信封。
 * version/type/domain 用于协议路由；payload/meta 承载业务变更；
 * pubKey/signature 用于端到端校验消息来源。
 */
export type P2PMessageBody = {
  version: string;
  type: 'broadcast' | 'sync' | string;
  domain: string;
  collection?: string;
  id?: string;
  payload: any;
  meta?: any;
  evidenceHeadHash?: string | null;
  timestamp: number;
  pubKey?: string;
  signature?: string;
};

/**
 * 一个可连接的远端节点描述。
 * peerId 可选（可从地址 /p2p/<peerId> 片段推导）。
 */
export type PeerNodeInfo = {
  peerId?: string;
  addresses: string[];
};

/**
 * 对外诊断信息：用于 UI 显示当前节点网络状态。
 */
export type LocalP2PNodeInfo = {
  initialized: boolean;
  started: boolean;
  peerId: string | null;
  addresses: string[];
  connectedPeers: string[];
  sparkSyncSubscribers: string[];
};

/**
 * 当前登录身份上下文。
 * P2P 同步流程通过它判断“我是谁”，避免误收并写入他人数据。
 */
export type P2PIdentityContext = {
  getCurrentRootId: () => Promise<string | null>;
};

/**
 * 节点活跃度统计：
 * - success/failure 用于稳定性评分
 * - cumulativeConnectedMs 用于在线时长优先排序
 */
export type PeerActivityRecord = {
  peerId: string;
  addresses: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  successCount: number;
  failureCount: number;
  cumulativeConnectedMs: number;
  currentSessionConnectedAt?: number;
  lastError?: string;
};
