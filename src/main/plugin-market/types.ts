import type { PluginPermission } from '../plugin-permissions';

export type PluginAsset = {
  kind: 'package';
  fileName: string;
  url: string;
  sha256: string;
  size: number;
};

export type PluginReleaseManifest = {
  manifestVersion: 1;
  pluginId: string;
  domain: string;
  version: string;
  releaseTime: string;
  /** 插件声明的权限清单（可选；缺省时按内置目录声明处理） */
  permissions?: string[];
  assets: PluginAsset[];
};

export type InstalledPluginState = {
  pluginId: string;
  version: string;
  packagePath: string;
  sha256: string;
  size: number;
  installedAt: number;
  enabled: boolean;
  /** 安装时授权并持久化的权限清单，运行时由主进程强制校验 */
  grantedPermissions: PluginPermission[];
};

export type PluginUpdateProbe = {
  pluginId: string;
  checkedAt: number;
  latestVersion: string | null;
  updateAvailable: boolean;
  reason: string;
};

export type PluginTrustConfig = {
  publicKeysPem: string[];
};
