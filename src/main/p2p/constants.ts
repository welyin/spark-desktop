/**
 * org-share 直连协议名：用于成员同步时的 request-response 通道。
 */
export const DIRECT_ORG_SHARE_PROTOCOL = '/spark/org-share/1.0.0';

/**
 * 对端版本探测协议：连接建立后请求远端返回当前应用版本。
 */
export const DIRECT_VERSION_PROTOCOL = '/spark/version/1.0.0';

/**
 * 本地持久化 libp2p 私钥的数据库键，确保同设备 PeerId 稳定。
 */
export const P2P_IDENTITY_PRIVATE_KEY = 'p2p:identity:privateKey';

/**
 * 本地持久化的 p2p ws 监听端口键。
 * 目标：端口只在冲突时迁移，一旦可用即保持稳定。
 */
export const P2P_LISTEN_WS_PORT = 'p2p:listen:wsPort';

/**
 * 默认 ws 监听端口（首次启动优先尝试）。
 */
export const P2P_DEFAULT_LISTEN_WS_PORT = 15002;

/**
 * 节点活跃度记录前缀：每个 peer 对应一条连接统计记录。
 */
export const P2P_PEER_RECORD_PREFIX = 'p2p:peer:record:';

/**
 * 组织元数据前缀：组织信息按 org:meta:<orgId> 存储。
 */
export const ORG_META_PREFIX = 'org:meta:';
