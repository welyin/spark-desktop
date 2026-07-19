import type { PluginPermission } from './permissions';

export type PluginCatalogItem = {
  id: string;
  domain: string;
  name: string;
  description: string;
  category: 'foundation' | 'business';
  version: string;
  views: string[];
  /** 插件声明的权限清单（基础权限无需声明，安装时向用户展示并授权） */
  permissions: PluginPermission[];
  package: {
    updateManifestUrl: string;
    signatureUrl: string;
    packageName: string;
    installCommand: string;
  };
};

const CATALOG: PluginCatalogItem[] = [
  {
    id: 'weibo-core',
    domain: 'plugin:weibo-core',
    name: '组织微博基础插件',
    description: '单主管理员发帖，组织成员评论/回复，基于插件域独立数据同步。',
    category: 'foundation',
    version: '0.1.0',
    views: ['default'],
    permissions: ['org:sync'],
    package: {
      updateManifestUrl: 'https://github.com/welyin/spark-desktop/releases/latest/download/spark-plugin-weibo-core-manifest.json',
      signatureUrl: 'https://github.com/welyin/spark-desktop/releases/latest/download/spark-plugin-weibo-core-manifest.sig',
      packageName: 'spark-plugin-weibo-core-0.1.0.spkg',
      installCommand: 'spark-plugin install spark-plugin-weibo-core-0.1.0.spkg'
    }
  }
];

export function listPluginCatalog(): PluginCatalogItem[] {
  return CATALOG.map((item) => ({ ...item, views: [...item.views], permissions: [...item.permissions], package: { ...item.package } }));
}

export function isKnownPluginDomain(domain: string): boolean {
  return CATALOG.some((item) => item.domain === domain);
}
