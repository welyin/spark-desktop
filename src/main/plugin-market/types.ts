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
