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
 * 覆盖网邻居池记录前缀：组织无关的 peer 地址簿（p2p:overlay:peer:<peerId>）。
 */
export const P2P_OVERLAY_PEER_PREFIX = 'p2p:overlay:peer:';

/**
 * 覆盖网邻居池容量上限：超出时淘汰最久未见的未验证条目。
 */
export const OVERLAY_POOL_MAX = 200;

/**
 * 活跃覆盖网连接目标数：低于该值时 keepalive 从邻居池补充拨号。
 */
export const OVERLAY_DIAL_TARGET = 4;

/**
 * 每个 keepalive tick 允许的最大覆盖网拨号次数。
 */
export const OVERLAY_TICK_DIAL_BUDGET = 2;

/**
 * peer-exchange 直连协议名：覆盖网邻居样本交换通道。
 */
export const DIRECT_PEER_EXCHANGE_PROTOCOL = '/spark/peer-exchange/1.0.0';

/**
 * 单次 peer-exchange 请求/响应的最大条目数。
 */
export const PEER_EXCHANGE_MAX = 16;

/**
 * 响应侧只分享该时间窗内见过的邻居（14 天），更旧的条目不再外发。
 */
export const PEER_EXCHANGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 响应侧限流：同一请求方两次服务的最小间隔。
 */
export const PEER_EXCHANGE_MIN_INTERVAL_MS = 60_000;

/**
 * 覆盖网控制面主题：node-announce 等网络层消息在这里传播，
 * 与承载业务数据的 spark-sync 主题分离（频率/限流/缓存可独立调）。
 */
export const OVERLAY_TOPIC = 'spark-overlay';

/**
 * node-announce 周期发送间隔（5 分钟）；地址变化时会立即补发一次。
 */
export const NODE_ANNOUNCE_INTERVAL_MS = 5 * 60_000;

/**
 * 接收侧限流：同一 peerId 的 announce 两次接受的最小间隔。
 * 例外：announce 携带邻居池中未知的新地址时（换地址即时补发），
 * 改用 NODE_ANNOUNCE_ACCEPT_MIN_INTERVAL_ON_CHANGE_MS 的较短下限。
 */
export const NODE_ANNOUNCE_ACCEPT_MIN_INTERVAL_MS = 60_000;

/**
 * 地址变化时的接收侧限流下限（防刷保留的最小间隔）。
 * 常规 60s 限流会把"刚接受过旧公告"的对端上的新地址公告整个吞掉，
 * 使"地址变化时立即补发"机制失效（新地址要等下一个 5 分钟周期才传播）。
 */
export const NODE_ANNOUNCE_ACCEPT_MIN_INTERVAL_ON_CHANGE_MS = 5_000;

/**
 * announce 时间戳新鲜度窗口（与 nodeInfoClaim 口径一致）。
 */
export const NODE_ANNOUNCE_MAX_AGE_MS = 10 * 60_000;

/**
 * org-recovery 直连协议名：组织失联时沿覆盖网定向寻找"知道路的人"。
 */
export const DIRECT_ORG_RECOVERY_PROTOCOL = '/spark/org-recovery/1.0.0';

/**
 * 恢复查询 token 时间桶（10 分钟）：查询与应答都计算当前+上一两个桶，消除桶边界漏配。
 */
export const RECOVERY_TIME_BUCKET_MS = 10 * 60_000;

/**
 * 恢复查询最大转发跳数（节制扩散，不做全网洪泛）。
 */
export const RECOVERY_TTL = 2;

/**
 * 单个组织两次恢复查询的最小间隔（冷却）。
 */
export const RECOVERY_COOLDOWN_MS = 10 * 60_000;

/**
 * 触发恢复查询前，组织侧"全员失联"需持续的 tick 数。
 */
export const RECOVERY_TRIGGER_CONSECUTIVE_TICKS = 3;

/**
 * 单次恢复查询请求的成员条目上限。
 */
export const RECOVERY_QUERY_WANT = 8;

/**
 * 应答侧限流：同一请求方两次恢复查询服务的最小间隔。
 */
export const RECOVERY_QUERY_MIN_INTERVAL_MS = 30_000;

/**
 * 组织元数据前缀：组织信息按 org:meta:<orgId> 存储。
 */
export const ORG_META_PREFIX = 'org:meta:';

/**
 * 组织同步记账前缀：按 p2p:org-sync-state:<peerId>:<orgId> 记录成员副本状态。
 * data-management 的过期清理按此前缀扫描。
 */
export const ORG_SYNC_STATE_PREFIX = 'p2p:org-sync-state:';

/**
 * 组织副本目标数（K）：副本可见与保活补副本共用的目标值。
 * 达到 K 个已同步节点（含本机）即视为副本充足。
 */
export const ORG_REPLICA_TARGET = 3;

/**
 * 副本“新鲜”窗口（30 天）：
 * sync-state 超过该窗口未刷新、且记录版本已落后当前组织版本时，
 * 视为历史触达而非现存副本，不再计入 syncedPeers。
 * （不能只用版本比较：每次编辑都会瞬间翻转为“不足”；也不能只用 TTL：
 * 静默组织不会刷新 sync-state，会误判健康副本为过期。）
 */
export const ORG_REPLICA_FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
