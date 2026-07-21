/**
 * 数据自动管理常量
 *
 * 设计口径（与产品设计 V2 §4.4.4 及开发计划一致）：
 * - 无绝对不清理的数据，只区分清理条件的严苛程度；系统优先保存最新数据；
 * - 治理类 append-only 与存证链"尽量保存"，其清理仅由管理员手动触发（见 purge.ts）；
 * - 容灾由 K 副本网络承担，本地不做周期备份，只提供手动导出转移（见 exporter.ts）。
 */

/** lww 删除标记（tombstone）保留期：超过 90 天视为已终结，自动清理 */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** p2p 节点活跃记录保留期：90 天未再出现的 peer 记录自动清理 */
export const PEER_RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** p2p 组织同步记账保留期：90 天未刷新的 sync-state 自动清理（K 副本 30 天新鲜窗口早已不计入） */
export const ORG_SYNC_STATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** 数据治理调度周期（1 小时） */
export const DATA_MAINTENANCE_INTERVAL_MS = 60 * 60_000;

/** 自动清理最小间隔（24 小时）：tick 到点但距上次清理不足该间隔则跳过 */
export const AUTO_CLEANUP_MIN_INTERVAL_MS = 24 * 60 * 60_000;

/** 软配额警告阈值：数据总字节超过该值时 UI 提示（不拒绝写入） */
export const USAGE_WARN_TOTAL_BYTES = 1 * 1024 * 1024 * 1024;

/** 磁盘可用比例警告阈值：低于该比例时 UI 提示管理员三选一（加磁盘/转移/清理） */
export const DISK_FREE_WARN_RATIO = 0.15;

/**
 * 前缀范围扫描的上界键：最大合法 UTF-8 码位（编码为 F4 8F BF BF）。
 * 不能用 'ÿ'（U+00FF，编码 C3 BF）——首字节大于 C3 的 id（如中文 E4+）
 * 会被静默排除在扫描范围之外。
 */
export const KEY_RANGE_UPPER_BOUND = '\u{10FFFF}';
