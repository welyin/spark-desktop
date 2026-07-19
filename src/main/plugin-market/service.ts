import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { compareSemver } from '../updater/semver';
import { verifyManifestSignature } from '../updater/signature';
import { computeFileSha256, downloadFile, fileSize, readJsonFile, writeJsonFile } from '../updater/io';
import type { PluginCatalogItem } from '../plugins/catalog';
import { listPluginCatalog } from '../plugins/catalog';
import { getPluginTrustConfig } from './trust';
import type { InstalledPluginState, PluginReleaseManifest, PluginUpdateProbe } from './types';
import type { PluginPermission } from '../plugins/permissions';
import { BASIC_PERMISSIONS, normalizeDeclaredPermissions, resolveGrantedPermissions } from '../plugins/permissions';

type PersistedPluginState = {
  installed: Record<string, InstalledPluginState>;
};

type PluginMarketItem = PluginCatalogItem & {
  installed: boolean;
  enabled: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  lastCheckReason: string;
};

const PLUGIN_STATE_FILE = 'plugin-market-state.json';

async function fetchTextSmart(url: string): Promise<string> {
  if (url.startsWith('file://')) {
    const filePath = new URL(url).pathname;
    return await fs.promises.readFile(filePath, 'utf8');
  }

  if (url.startsWith('/')) {
    return await fs.promises.readFile(url, 'utf8');
  }

  if (url.startsWith('http://')) {
    throw new Error('Insecure plugin manifest URL is not allowed');
  }

  const { fetchText } = await import('../updater/io');
  return await fetchText(url);
}

function toFileUrl(filePath: string): string {
  return `file://${filePath}`;
}

function normalizeFileUrl(url: string): string {
  if (url.startsWith('file://')) {
    return url;
  }
  if (url.startsWith('/')) {
    return toFileUrl(url);
  }
  return url;
}

function resolveLocalReleaseDirs(pluginId: string): string[] {
  const appPath = app.getAppPath();
  const candidates = [
    path.resolve(appPath, 'dist', 'plugins', pluginId),
    path.resolve(appPath, '..', 'dist', 'plugins', pluginId),
    path.resolve(process.cwd(), 'dist', 'plugins', pluginId)
  ];

  const unique = new Set<string>();
  for (const dir of candidates) {
    unique.add(path.normalize(dir));
  }
  return [...unique];
}

function resolveLocalSourcePluginDirs(pluginId: string): string[] {
  const appPath = app.getAppPath();
  const candidates = [
    path.resolve(appPath, 'src', 'plugins', pluginId),
    path.resolve(appPath, '..', 'src', 'plugins', pluginId),
    path.resolve(process.cwd(), 'src', 'plugins', pluginId)
  ];

  const unique = new Set<string>();
  for (const dir of candidates) {
    unique.add(path.normalize(dir));
  }
  return [...unique];
}

export class PluginMarketService {
  private readonly stateFilePath: string;
  private state: PersistedPluginState = { installed: {} };
  private updateProbes: Record<string, PluginUpdateProbe> = {};

  constructor() {
    this.stateFilePath = path.join(app.getPath('userData'), PLUGIN_STATE_FILE);
  }

  async initialize(): Promise<void> {
    this.state = await readJsonFile<PersistedPluginState>(this.stateFilePath, { installed: {} });
    await this.backfillGrantedPermissions();
    await this.reconcileBundledInstalledState();
  }

  /** 兼容旧版安装状态：缺失 grantedPermissions 时按目录声明回填 */
  private async backfillGrantedPermissions(): Promise<void> {
    let changed = false;
    for (const [pluginId, installed] of Object.entries(this.state.installed)) {
      if (Array.isArray(installed.grantedPermissions)) {
        continue;
      }
      const item = listPluginCatalog().find((catalog) => catalog.id === pluginId);
      installed.grantedPermissions = item ? resolveGrantedPermissions(item.permissions) : [...BASIC_PERMISSIONS];
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  private resolveDeclaredPermissions(item: PluginCatalogItem, manifest?: PluginReleaseManifest): PluginPermission[] {
    const declared = manifest?.permissions ? normalizeDeclaredPermissions(manifest.permissions) : item.permissions;
    return resolveGrantedPermissions(declared);
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.stateFilePath, this.state);
  }

  private findCatalogItem(pluginId: string): PluginCatalogItem {
    const item = listPluginCatalog().find((catalog) => catalog.id === pluginId);
    if (!item) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    return item;
  }

  private resolveManifestEndpoints(item: PluginCatalogItem): { manifestUrl: string; signatureUrl: string } {
    const bundled = this.resolveBundledManifestPaths(item);
    if (bundled) {
      return {
        manifestUrl: toFileUrl(bundled.manifestPath),
        signatureUrl: toFileUrl(bundled.signaturePath)
      };
    }

    return {
      manifestUrl: normalizeFileUrl(item.package.updateManifestUrl),
      signatureUrl: normalizeFileUrl(item.package.signatureUrl)
    };
  }

  private resolveBundledManifestPaths(item: PluginCatalogItem): { manifestPath: string; signaturePath: string; localDir: string } | null {
    for (const localDir of resolveLocalReleaseDirs(item.id)) {
      const manifestPath = path.join(localDir, 'update-manifest.json');
      const signaturePath = path.join(localDir, 'update-manifest.sig');
      if (!fs.existsSync(manifestPath) || !fs.existsSync(signaturePath)) {
        continue;
      }

      return {
        manifestPath,
        signaturePath,
        localDir
      };
    }
    return null;
  }

  private resolveBundledSourcePluginDir(item: PluginCatalogItem): string | null {
    for (const dir of resolveLocalSourcePluginDirs(item.id)) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      const hasManifestTs = fs.existsSync(path.join(dir, 'manifest.ts'));
      const hasManifestJs = fs.existsSync(path.join(dir, 'manifest.js'));
      if (hasManifestTs || hasManifestJs) {
        return dir;
      }
    }
    return null;
  }

  private buildDevSourceInstalledState(item: PluginCatalogItem): InstalledPluginState | null {
    const sourceDir = this.resolveBundledSourcePluginDir(item);
    if (!sourceDir) {
      return null;
    }

    return {
      pluginId: item.id,
      version: item.version,
      packagePath: sourceDir,
      sha256: 'bundled-dev-source',
      size: 0,
      installedAt: 0,
      enabled: true,
      grantedPermissions: resolveGrantedPermissions(item.permissions)
    };
  }

  private async reconcileBundledInstalledState(): Promise<void> {
    const trust = getPluginTrustConfig();
    let changed = false;

    for (const item of listPluginCatalog()) {
      if (this.state.installed[item.id]) {
        continue;
      }

      const bundled = this.resolveBundledManifestPaths(item);
      if (bundled) {
        try {
          const manifestText = await fs.promises.readFile(bundled.manifestPath, 'utf8');
          const signatureText = (await fs.promises.readFile(bundled.signaturePath, 'utf8')).trim();
          const verified = verifyManifestSignature(manifestText, signatureText, trust.publicKeysPem);
          if (!verified) {
            continue;
          }

          const manifest = JSON.parse(manifestText) as PluginReleaseManifest;
          if (manifest.pluginId !== item.id || manifest.domain !== item.domain) {
            continue;
          }

          const asset = manifest.assets.find((entry) => entry.kind === 'package');
          if (!asset) {
            continue;
          }

          const packagePath = path.join(bundled.localDir, asset.fileName);
          if (!fs.existsSync(packagePath)) {
            continue;
          }

          const digest = await computeFileSha256(packagePath);
          const size = await fileSize(packagePath);
          if (digest !== asset.sha256 || size !== asset.size) {
            continue;
          }

          this.state.installed[item.id] = {
            pluginId: item.id,
            version: manifest.version,
            packagePath,
            sha256: digest,
            size,
            installedAt: Date.now(),
            enabled: true,
            grantedPermissions: this.resolveDeclaredPermissions(item, manifest)
          };
          this.updateProbes[item.id] = {
            pluginId: item.id,
            checkedAt: Date.now(),
            latestVersion: manifest.version,
            updateAvailable: false,
            reason: 'bundled'
          };
          changed = true;
        } catch {
          // Ignore broken local bundle metadata and keep explicit install flow available.
        }
      }

      if (this.state.installed[item.id]) {
        continue;
      }

      const sourceDir = this.resolveBundledSourcePluginDir(item);
      if (!sourceDir) {
        continue;
      }

      this.state.installed[item.id] = {
        pluginId: item.id,
        version: item.version,
        packagePath: sourceDir,
        sha256: 'bundled-dev-source',
        size: 0,
        installedAt: Date.now(),
        enabled: true,
        grantedPermissions: resolveGrantedPermissions(item.permissions)
      };
      this.updateProbes[item.id] = {
        pluginId: item.id,
        checkedAt: Date.now(),
        latestVersion: item.version,
        updateAvailable: false,
        reason: 'bundled-dev-source'
      };
      changed = true;
    }

    if (changed) {
      await this.persist();
    }
  }

  private async loadVerifiedManifest(item: PluginCatalogItem): Promise<PluginReleaseManifest> {
    const trust = getPluginTrustConfig();
    const endpoints = this.resolveManifestEndpoints(item);

    const manifestText = await fetchTextSmart(endpoints.manifestUrl);
    const signatureText = (await fetchTextSmart(endpoints.signatureUrl)).trim();

    const ok = verifyManifestSignature(manifestText, signatureText, trust.publicKeysPem);
    if (!ok) {
      throw new Error(`Plugin manifest signature verification failed: ${item.id}`);
    }

    const manifest = JSON.parse(manifestText) as PluginReleaseManifest;
    if (manifest.pluginId !== item.id) {
      throw new Error(`Plugin manifest id mismatch: expected ${item.id}, got ${manifest.pluginId}`);
    }
    if (manifest.domain !== item.domain) {
      throw new Error(`Plugin manifest domain mismatch: expected ${item.domain}, got ${manifest.domain}`);
    }

    return manifest;
  }

  private async downloadAndVerifyAsset(asset: PluginReleaseManifest['assets'][number], pluginId: string): Promise<{ filePath: string; sha256: string; size: number }> {
    const pluginDir = path.join(app.getPath('userData'), 'plugins', pluginId, 'packages');
    await fs.promises.mkdir(pluginDir, { recursive: true });
    const filePath = path.join(pluginDir, asset.fileName);

    const url = normalizeFileUrl(asset.url);
    if (url.startsWith('file://')) {
      const sourcePath = new URL(url).pathname;
      await fs.promises.copyFile(sourcePath, filePath);
    } else {
      await downloadFile(url, filePath);
    }

    const digest = await computeFileSha256(filePath);
    if (digest !== asset.sha256) {
      throw new Error(`Plugin package sha256 mismatch for ${pluginId}`);
    }

    const actualSize = await fileSize(filePath);
    if (actualSize !== asset.size) {
      throw new Error(`Plugin package size mismatch for ${pluginId}`);
    }

    return {
      filePath,
      sha256: digest,
      size: actualSize
    };
  }

  async checkForUpdates(pluginId?: string): Promise<PluginUpdateProbe[]> {
    const catalog = listPluginCatalog();
    const targets = pluginId ? catalog.filter((item) => item.id === pluginId) : catalog;

    if (pluginId && targets.length === 0) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    const probes: PluginUpdateProbe[] = [];

    for (const item of targets) {
      try {
        const manifest = await this.loadVerifiedManifest(item);
        const installed = this.state.installed[item.id];
        const current = installed?.version;
        const updateAvailable = current ? compareSemver(manifest.version, current) > 0 : false;

        const probe: PluginUpdateProbe = {
          pluginId: item.id,
          checkedAt: Date.now(),
          latestVersion: manifest.version,
          updateAvailable,
          reason: updateAvailable ? 'new-version-available' : 'up-to-date'
        };
        this.updateProbes[item.id] = probe;
        probes.push(probe);
      } catch (error) {
        const probe: PluginUpdateProbe = {
          pluginId: item.id,
          checkedAt: Date.now(),
          latestVersion: null,
          updateAvailable: false,
          reason: `check-failed: ${String(error)}`
        };
        this.updateProbes[item.id] = probe;
        probes.push(probe);
      }
    }

    return probes;
  }

  async install(pluginId: string): Promise<InstalledPluginState> {
    const item = this.findCatalogItem(pluginId);
    const manifest = await this.loadVerifiedManifest(item);
    const asset = manifest.assets.find((entry) => entry.kind === 'package');
    if (!asset) {
      throw new Error(`No package asset found for plugin ${pluginId}`);
    }

    const downloaded = await this.downloadAndVerifyAsset(asset, pluginId);
    const installedState: InstalledPluginState = {
      pluginId,
      version: manifest.version,
      packagePath: downloaded.filePath,
      sha256: downloaded.sha256,
      size: downloaded.size,
      installedAt: Date.now(),
      enabled: true,
      grantedPermissions: this.resolveDeclaredPermissions(item, manifest)
    };

    this.state.installed[pluginId] = installedState;
    this.updateProbes[pluginId] = {
      pluginId,
      checkedAt: Date.now(),
      latestVersion: manifest.version,
      updateAvailable: false,
      reason: 'installed'
    };
    await this.persist();
    return installedState;
  }

  async upgrade(pluginId: string): Promise<InstalledPluginState> {
    if (!this.state.installed[pluginId]) {
      throw new Error(`Plugin is not installed: ${pluginId}`);
    }
    const upgraded = await this.install(pluginId);
    this.updateProbes[pluginId] = {
      pluginId,
      checkedAt: Date.now(),
      latestVersion: upgraded.version,
      updateAvailable: false,
      reason: 'upgraded'
    };
    await this.persist();
    return upgraded;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<InstalledPluginState> {
    const installed = this.state.installed[pluginId];
    if (!installed) {
      throw new Error(`Plugin is not installed: ${pluginId}`);
    }

    installed.enabled = enabled;
    this.state.installed[pluginId] = installed;
    await this.persist();
    return installed;
  }

  /**
   * 查询指定插件域已授权的权限清单（运行时 IPC 权限校验用）
   * 未安装或未知插件域仅返回基础权限
   */
  getGrantedPermissionsForDomain(domain: string): PluginPermission[] {
    const item = listPluginCatalog().find((catalog) => catalog.domain === domain);
    if (!item) {
      return [...BASIC_PERMISSIONS];
    }
    const installed = this.state.installed[item.id] ?? this.buildDevSourceInstalledState(item);
    return installed?.grantedPermissions ?? resolveGrantedPermissions(item.permissions);
  }

  listMarket(): PluginMarketItem[] {
    const catalog = listPluginCatalog();

    return catalog.map((item) => {
      const installed = this.state.installed[item.id] ?? this.buildDevSourceInstalledState(item);
      const probe = this.updateProbes[item.id] ?? null;

      return {
        ...item,
        installed: Boolean(installed),
        enabled: installed?.enabled ?? false,
        installedVersion: installed?.version ?? null,
        latestVersion: probe?.latestVersion ?? null,
        updateAvailable: probe?.updateAvailable ?? false,
        lastCheckedAt: probe?.checkedAt ?? null,
        lastCheckReason: probe?.reason ?? 'not-checked'
      };
    });
  }
}
