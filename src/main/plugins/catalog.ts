export type PluginCatalogItem = {
  id: string;
  domain: string;
  name: string;
  description: string;
  category: 'foundation' | 'business';
  version: string;
  views: string[];
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
    package: {
      updateManifestUrl: 'https://github.com/welyin/spark-desktop/releases/latest/download/spark-plugin-weibo-core-manifest.json',
      signatureUrl: 'https://github.com/welyin/spark-desktop/releases/latest/download/spark-plugin-weibo-core-manifest.sig',
      packageName: 'spark-plugin-weibo-core-0.1.0.spkg',
      installCommand: 'spark-plugin install spark-plugin-weibo-core-0.1.0.spkg'
    }
  }
];

export function listPluginCatalog(): PluginCatalogItem[] {
  return CATALOG.map((item) => ({ ...item, views: [...item.views], package: { ...item.package } }));
}

export function isKnownPluginDomain(domain: string): boolean {
  return CATALOG.some((item) => item.domain === domain);
}
