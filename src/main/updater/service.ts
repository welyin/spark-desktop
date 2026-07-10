import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { compareSemver, maxSemver } from './semver';
import { fileSize, fetchText, computeFileSha256, downloadFile, readJsonFile, writeJsonFile } from './io';
import { verifyManifestSignature } from './signature';
import { getUpdateTrustConfig, type UpdateTrustConfig } from './trust';
import type { PeerVersionObservation, StagedUpdateInfo, UpdateAsset, UpdateCheckResult, UpdateManifest, UpdaterSnapshot } from './types';

type UpdaterState = {
  highestAcceptedVersion: string;
  latestCheck: UpdateCheckResult | null;
  staged: StagedUpdateInfo | null;
  peerObservations: PeerVersionObservation[];
};

type PendingInstallState = {
  staged: StagedUpdateInfo;
};

type UpdaterServiceDeps = {
  fetchText: (url: string) => Promise<string>;
  downloadFile: (url: string, destination: string) => Promise<void>;
};

const UPDATER_DIR = 'updater';
const STATE_FILE = 'state.json';
const PENDING_FILE = 'pending-install.json';
const MAX_PEER_OBSERVATIONS = 50;

function execFilePromise(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${String(stderr || error.message)}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function assertManifestShape(manifest: UpdateManifest): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest payload');
  }
  if (!manifest.appId || !manifest.version || !Array.isArray(manifest.assets)) {
    throw new Error('Manifest missing required fields');
  }
  if (manifest.assets.length === 0) {
    throw new Error('Manifest does not provide assets');
  }
}

function isNewer(version: string, base: string): boolean {
  return compareSemver(version, base) > 0;
}

export class UpdaterService {
  private readonly trust: UpdateTrustConfig;
  private readonly deps: UpdaterServiceDeps;
  private latestManifest: UpdateManifest | null = null;
  private readonly stateFilePath: string;
  private readonly pendingFilePath: string;

  constructor(
    private readonly userDataPath: string,
    private readonly currentVersion: string,
    deps?: Partial<UpdaterServiceDeps>
  ) {
    this.trust = getUpdateTrustConfig();
    this.deps = {
      fetchText: deps?.fetchText ?? fetchText,
      downloadFile: deps?.downloadFile ?? downloadFile
    };

    this.stateFilePath = path.join(this.userDataPath, UPDATER_DIR, STATE_FILE);
    this.pendingFilePath = path.join(this.userDataPath, UPDATER_DIR, PENDING_FILE);
  }

  isConfigured(): boolean {
    return this.trust.publicKeysPem.length > 0;
  }

  async getSnapshot(): Promise<UpdaterSnapshot> {
    const state = await this.readState();
    return {
      configured: this.isConfigured(),
      appId: this.trust.appId,
      channel: this.trust.channel,
      currentVersion: this.currentVersion,
      highestAcceptedVersion: state.highestAcceptedVersion,
      latestCheck: state.latestCheck,
      staged: state.staged,
      peerObservations: state.peerObservations
    };
  }

  async processPendingInstall(): Promise<void> {
    const pending = await readJsonFile<PendingInstallState | null>(this.pendingFilePath, null);
    if (!pending?.staged?.filePath) {
      return;
    }

    try {
      await fs.promises.access(pending.staged.filePath, fs.constants.R_OK);
    } catch {
      await fs.promises.rm(this.pendingFilePath, { force: true });
      return;
    }

    try {
      await this.openInstaller(pending.staged.filePath);
      await fs.promises.rm(this.pendingFilePath, { force: true });
    } catch (error) {
      console.warn('[updater] open installer failed', error);
    }
  }

  async checkForUpdates(source: 'manual' | 'startup' | 'peer-observed'): Promise<UpdateCheckResult> {
    if (!this.isConfigured()) {
      throw new Error('Updater is not configured: SPARK_UPDATE_PUBLIC_KEY_PEM is empty');
    }

    const [manifestText, signatureText] = await Promise.all([
      this.deps.fetchText(this.trust.manifestUrl),
      this.deps.fetchText(this.trust.signatureUrl)
    ]);

    const signatureOk = verifyManifestSignature(manifestText, signatureText, this.trust.publicKeysPem);
    if (!signatureOk) {
      throw new Error('Manifest signature verification failed');
    }

    const manifest = JSON.parse(manifestText) as UpdateManifest;
    assertManifestShape(manifest);

    if (manifest.appId !== this.trust.appId) {
      throw new Error(`Manifest appId mismatch: expected=${this.trust.appId}, actual=${manifest.appId}`);
    }
    if (manifest.channel !== this.trust.channel) {
      throw new Error(`Manifest channel mismatch: expected=${this.trust.channel}, actual=${manifest.channel}`);
    }

    const revokedCurrentVersion = (manifest.revokedVersions ?? []).includes(this.currentVersion);
    const updateAvailable = isNewer(manifest.version, this.currentVersion);

    if (manifest.minSupportedVersion && compareSemver(this.currentVersion, manifest.minSupportedVersion) < 0) {
      console.warn('[updater] current version is below minSupportedVersion', {
        currentVersion: this.currentVersion,
        minSupportedVersion: manifest.minSupportedVersion
      });
    }

    const result: UpdateCheckResult = {
      checkedAt: Date.now(),
      source,
      currentVersion: this.currentVersion,
      availableVersion: updateAvailable ? manifest.version : null,
      updateAvailable,
      critical: Boolean(manifest.critical),
      revokedCurrentVersion,
      reason: updateAvailable ? 'new-version-available' : 'already-latest'
    };

    this.latestManifest = manifest;

    const state = await this.readState();
    state.latestCheck = result;
    await this.writeState(state);

    return result;
  }

  async stageLatestFullUpdate(): Promise<StagedUpdateInfo> {
    if (!this.latestManifest) {
      throw new Error('No manifest loaded, call checkForUpdates first');
    }

    if (!isNewer(this.latestManifest.version, this.currentVersion)) {
      throw new Error('No newer version available');
    }

    const state = await this.readState();
    if (compareSemver(this.latestManifest.version, state.highestAcceptedVersion) < 0) {
      throw new Error('Refusing rollback target version');
    }

    const targetAsset = this.selectFullAsset(this.latestManifest.assets);
    const stageDir = path.join(this.userDataPath, UPDATER_DIR, 'staging', this.latestManifest.version);
    const filePath = path.join(stageDir, targetAsset.fileName);
    const tempPath = `${filePath}.part`;

    await fs.promises.mkdir(stageDir, { recursive: true });
    await this.deps.downloadFile(targetAsset.url, tempPath);
    await fs.promises.rename(tempPath, filePath);

    const actualSize = await fileSize(filePath);
    if (actualSize !== targetAsset.size) {
      throw new Error(`Size mismatch: expected=${targetAsset.size}, actual=${actualSize}`);
    }

    const actualHash = await computeFileSha256(filePath);
    if (actualHash.toLowerCase() !== targetAsset.sha256.toLowerCase()) {
      throw new Error('SHA256 mismatch for downloaded update package');
    }

    await this.verifyPlatformSignature(filePath, targetAsset);

    const staged: StagedUpdateInfo = {
      version: this.latestManifest.version,
      filePath,
      fileName: targetAsset.fileName,
      sha256: actualHash,
      size: actualSize,
      stagedAt: Date.now()
    };

    state.staged = staged;
    await this.writeState(state);
    return staged;
  }

  async applyStagedUpdateAndRestart(): Promise<{ success: boolean }> {
    const state = await this.readState();
    const staged = state.staged;
    if (!staged) {
      throw new Error('No staged update package');
    }

    if (compareSemver(staged.version, state.highestAcceptedVersion) < 0) {
      throw new Error('Staged version is below anti-rollback floor');
    }

    await writeJsonFile(this.pendingFilePath, { staged } satisfies PendingInstallState);

    state.highestAcceptedVersion = maxSemver(state.highestAcceptedVersion, staged.version);
    await this.writeState(state);

    app.relaunch();
    app.exit(0);

    return { success: true };
  }

  async observePeerVersion(version: string, peerId = 'unknown'): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const state = await this.readState();
    const triggeredCheck = isNewer(version, this.currentVersion);
    state.peerObservations = [
      {
        peerId,
        observedVersion: version,
        observedAt: Date.now(),
        triggeredCheck
      },
      ...state.peerObservations
    ].slice(0, MAX_PEER_OBSERVATIONS);
    await this.writeState(state);

    try {
      if (!triggeredCheck) {
        return;
      }
      await this.checkForUpdates('peer-observed');
    } catch (error) {
      console.warn('[updater] peer-triggered update check failed', error);
    }
  }

  private selectFullAsset(assets: UpdateAsset[]): UpdateAsset {
    const matched = assets.find((asset) => {
      return (
        asset.kind === 'full' &&
        asset.platform === process.platform &&
        asset.arch === process.arch
      );
    });

    if (!matched) {
      throw new Error(`No asset for platform=${process.platform}, arch=${process.arch}`);
    }

    return matched;
  }

  private async verifyPlatformSignature(filePath: string, asset: UpdateAsset): Promise<void> {
    if (!asset.codeSignSubject) {
      return;
    }

    if (process.platform !== 'darwin') {
      throw new Error('codeSignSubject verification is currently implemented for darwin only');
    }

    const extension = path.extname(filePath).toLowerCase();
    const args = extension === '.dmg'
      ? ['-a', '-vv', '--type', 'open', filePath]
      : ['-a', '-vv', filePath];

    const result = await execFilePromise('spctl', args);
    const output = `${result.stdout}\n${result.stderr}`;
    if (!output.includes(asset.codeSignSubject)) {
      throw new Error(`Signer subject mismatch, expected=${asset.codeSignSubject}`);
    }
  }

  private async openInstaller(filePath: string): Promise<void> {
    if (process.platform === 'darwin') {
      await execFilePromise('open', [filePath]);
      return;
    }

    if (process.platform === 'win32') {
      await execFilePromise('cmd', ['/c', 'start', '', filePath]);
      return;
    }

    await execFilePromise('xdg-open', [filePath]);
  }

  private async readState(): Promise<UpdaterState> {
    return await readJsonFile<UpdaterState>(this.stateFilePath, {
      highestAcceptedVersion: this.currentVersion,
      latestCheck: null,
      staged: null,
      peerObservations: []
    });
  }

  private async writeState(state: UpdaterState): Promise<void> {
    await writeJsonFile(this.stateFilePath, state);
  }
}
