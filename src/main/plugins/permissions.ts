/**
 * 插件权限模型
 *
 * 设计文档（V2 §4.5.2）定义的权限分级：
 * - 基础权限：默认授予，无需插件声明（本域数据读写、组织读取、存证核验）
 * - 高级权限：插件必须在 manifest 中声明，安装时由用户/管理员授权，
 *   运行时由主进程在 IPC 边界强制校验，越权调用直接拒绝
 *
 * 安全说明：授权结果持久化在插件安装状态（InstalledPluginState.grantedPermissions），
 * 渲染进程无法自报或修改权限；主进程按调用方窗口绑定的可信域查询授权。
 */

export const PLUGIN_PERMISSIONS = [
  'storage:read',
  'storage:write',
  'org:read',
  'org:sync',
  'network:broadcast',
  'proof:verify',
  'identity:sign'
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** 基础权限：默认授予所有插件，无需声明 */
export const BASIC_PERMISSIONS: readonly PluginPermission[] = [
  'storage:read',
  'storage:write',
  'org:read',
  'proof:verify'
];

/** 高级权限：必须声明并经安装时授权 */
export const ADVANCED_PERMISSIONS: readonly PluginPermission[] = [
  'org:sync',
  'network:broadcast',
  'identity:sign'
];

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * 规范化插件声明的权限列表：过滤非法项、去重
 */
export function normalizeDeclaredPermissions(declared: unknown): PluginPermission[] {
  if (!Array.isArray(declared)) {
    return [];
  }
  const result = new Set<PluginPermission>();
  for (const item of declared) {
    if (isPluginPermission(item)) {
      result.add(item);
    }
  }
  return [...result];
}

/**
 * 计算插件实际获得的权限：
 * 基础权限恒授予；高级权限仅在声明（并经安装授权流程确认）后授予
 */
export function resolveGrantedPermissions(declared: readonly PluginPermission[]): PluginPermission[] {
  const granted = new Set<PluginPermission>(BASIC_PERMISSIONS);
  for (const permission of declared) {
    if (ADVANCED_PERMISSIONS.includes(permission)) {
      granted.add(permission);
    }
  }
  return [...granted];
}
