import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { verifyAccess } from '../db';
import { getDomain, isSystemDomain, isValidPluginDomain } from '../domain-registry';
import { getPluginMarketService } from '../plugin-market';
import type { PluginPermission } from '../plugins/permissions';

/**
 * IPC 调用方的域访问控制
 *
 * 安全模型：渲染进程的域身份由主进程在创建窗口时绑定（domain-registry），
 * 渲染进程自身无法修改。所有 IPC handler 通过这些守卫识别调用方并强制隔离。
 */

/**
 * 从 IPC 事件中获取可信的调用者域
 * 未注册的窗口返回 null，调用方应拒绝访问
 */
export function getCallerDomain(event: IpcMainInvokeEvent): string | null {
  return getDomain(event.sender.id);
}

/**
 * 校验调用者是否为系统域
 */
export function requireSystemDomain(event: IpcMainInvokeEvent): void {
  const caller = getCallerDomain(event);
  if (!caller || !isSystemDomain(caller)) {
    throw new Error('Access denied: system domain required');
  }
}

/**
 * 校验调用者域对目标域的访问权限
 */
export function requireAccess(event: IpcMainInvokeEvent, targetDomain: string | null): void {
  const caller = getCallerDomain(event);
  if (!caller) {
    throw new Error('Access denied: unregistered caller domain');
  }
  verifyAccess(caller, targetDomain);
}

export function resolvePluginDomainAccess(event: IpcMainInvokeEvent, requestedDomain?: string): string {
  const caller = getCallerDomain(event);

  if (caller && isValidPluginDomain(caller)) {
    if (requestedDomain && requestedDomain !== caller) {
      throw new Error('Access denied: plugin domain mismatch');
    }
    return caller;
  }

  if (caller && isSystemDomain(caller)) {
    if (!requestedDomain || !isValidPluginDomain(requestedDomain)) {
      throw new Error('Access denied: valid plugin domain is required for system caller');
    }
    return requestedDomain;
  }

  throw new Error('Access denied: plugin domain required');
}

/**
 * 校验调用方插件域是否已授予指定权限（权限分级运行时强制点）
 * 系统域代管调用（携带 pluginDomain 参数）视为可信，直接放行
 */
export function requirePluginPermission(event: IpcMainInvokeEvent, permission: PluginPermission, requestedDomain?: string): string {
  const domain = resolvePluginDomainAccess(event, requestedDomain);
  const caller = getCallerDomain(event);
  if (caller && isSystemDomain(caller)) {
    return domain;
  }
  const granted = getPluginMarketService().getGrantedPermissionsForDomain(domain);
  if (!granted.includes(permission)) {
    throw new Error(`Access denied: permission "${permission}" is not granted for ${domain}`);
  }
  return domain;
}

export function registerInvokeHandler(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
}
