/**
 * 域身份注册表
 *
 * 安全模型：渲染进程的域身份由主进程在创建窗口时绑定，
 * 渲染进程自身无法修改。所有 IPC handler 通过 sender.webContents.id
 * 从这里查询可信的 callerDomain，不再信任渲染进程自报的 domain。
 *
 * 域类型：
 * - system: 系统主窗口，拥有全部权限
 * - plugin:xxx: 插件窗口，只能访问自身插件域
 * - evidence: 存证域（不可直接作为 callerDomain，仅供内部使用）
 */

const domainMap = new Map<number, string>();

/**
 * 为指定 webContents 注册可信域身份
 * 仅应在创建窗口 / 加载插件时由主进程调用
 */
export function registerDomain(webContentsId: number, domain: string): void {
  if (!domain || typeof domain !== 'string') {
    throw new Error('Invalid domain');
  }
  domainMap.set(webContentsId, domain);
}

/**
 * 查询指定 webContents 的可信域身份
 * 未注册的窗口返回 null，IPC handler 应拒绝其访问
 */
export function getDomain(webContentsId: number): string | null {
  return domainMap.get(webContentsId) ?? null;
}

/**
 * 注销域身份（窗口关闭时调用，防止内存泄漏）
 */
export function unregisterDomain(webContentsId: number): void {
  domainMap.delete(webContentsId);
}

/**
 * 校验插件域格式（必须以 plugin: 开头）
 */
export function isValidPluginDomain(domain: string): boolean {
  return typeof domain === 'string' && domain.startsWith('plugin:') && domain.length > 'plugin:'.length;
}

/**
 * 校验系统域
 */
export function isSystemDomain(domain: string): boolean {
  return domain === 'system';
}
