/**
 * 域与权限管理模块
 * - 负责定义系统/插件/存证域前缀规范
 * - 提供从键解析域、权限校验以及系统域初始化逻辑
 */
import { LevelDB } from './base';

export const DOMAIN_SYSTEM = 'system';
export const DOMAIN_PLUGIN_PREFIX = 'plugin:'; // 完整 plugin 域示例：plugin:my-plugin-id
export const DOMAIN_EVIDENCE = 'evidence';

/** 将 pluginId 转换为插件域字符串 */
export function pluginDomain(pluginId: string) {
  return `${DOMAIN_PLUGIN_PREFIX}${pluginId}`;
}

/**
 * 从存储键中解析出域名（支持主文档与索引键）
 * - 主键格式：doc:{domain}:{collection}:{id}
 * - 索引格式：idx:{domain}:{collection}:{indexName}:{indexValue}:{id}
 */
export function parseDomainFromKey(key: string): string | null {
  if (key.startsWith('doc:')) {
    const parts = key.split(':');
    if (parts.length >= 4) {
      return parts.slice(1, parts.length - 2).join(':');
    }
    return null;
  }
  if (key.startsWith('idx:')) {
    const parts = key.split(':');
    if (parts.length >= 6) {
      return parts.slice(1, parts.length - 4).join(':');
    }
    return null;
  }
  return null;
}

/**
 * 权限校验：插件只能访问自身域；系统域拥有全部权限
 * - callerDomain: 发起者域（例如 plugin:abc 或 system）
 * - targetDomain: 目标资源域（从 key 或参数推断）
 * 抛出错误表示拒绝访问
 */
export function verifyAccess(callerDomain: string | undefined | null, targetDomain: string | null | undefined) {
  // 若未提供 callerDomain，视作 system（兼容旧调用）
  const caller = callerDomain ?? DOMAIN_SYSTEM;
  // 若无法解析 targetDomain，则不进行限制（保守策略可改为拒绝）
  if (!targetDomain) return;

  if (caller === DOMAIN_SYSTEM) return; // 系统有全部访问权限

  if (caller.startsWith(DOMAIN_PLUGIN_PREFIX)) {
    // 插件仅能访问同名 plugin 域
    if (caller !== targetDomain) {
      throw new Error(`Permission denied: plugin ${caller} cannot access domain ${targetDomain}`);
    }
    return;
  }

  if (caller === DOMAIN_EVIDENCE) {
    // 存证域默认不可跨域访问（仅示例策略）
    if (caller !== targetDomain) {
      throw new Error(`Permission denied: evidence domain cannot access ${targetDomain}`);
    }
    return;
  }

  // 其他未知域保守拒绝
  throw new Error(`Permission denied: unknown caller domain ${caller}`);
}

/**
 * 初始化系统保留域：写入默认配置与节点信息。
 * - 仅在未初始化时写入，避免覆盖已有数据
 */
export async function ensureSystemDomainInitialized(db: LevelDB): Promise<void> {
  // 约定元信息键：doc:system:meta:initialized -> 'true'
  const initKey = `doc:${DOMAIN_SYSTEM}:meta:initialized`;
  try {
    const v = await db.get(initKey);
    if (v !== null) return; // 已初始化
  } catch (err) {
    // db.get 已在 LevelDB 中处理 notFound 返回 null
  }

  const now = Date.now();
  const defaultConfig = {
    appName: 'spark-desktop',
    version: '1.0.0',
    createdAt: now
  };

  const nodeInfo = {
    id: 'local-node',
    hostname: 'localhost',
    createdAt: now
  };

  const ops = [
    { type: 'put' as const, key: `doc:${DOMAIN_SYSTEM}:config:default`, value: JSON.stringify(defaultConfig) },
    { type: 'put' as const, key: `doc:${DOMAIN_SYSTEM}:node:local`, value: JSON.stringify(nodeInfo) },
    { type: 'put' as const, key: initKey, value: 'true' }
  ];

  await db.batch(ops as any);
}
