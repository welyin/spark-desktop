export type UpdateChannel = 'stable' | 'canary';

export type UpdateAsset = {
  kind: 'full';
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  fileName: string;
  url: string;
  sha256: string;
  size: number;
  codeSignSubject?: string;
};

export type UpdatePatchAsset = {
  kind: 'patch';
  fromVersion: string;
  toVersion: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  fileName: string;
  url: string;
  sha256: string;
  size: number;
};

export type UpdateManifest = {
  manifestVersion: number;
  appId: string;
  channel: UpdateChannel;
  version: string;
  minSupportedVersion?: string;
  minProtocolVersion?: number;
  releaseTime: string;
  critical?: boolean;
  revokedVersions?: string[];
  assets: UpdateAsset[];
  patches?: UpdatePatchAsset[];
};

export type UpdateCheckResult = {
  checkedAt: number;
  source: 'manual' | 'startup' | 'peer-observed';
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  critical: boolean;
  revokedCurrentVersion: boolean;
  reason: string;
};

export type StagedUpdateInfo = {
  version: string;
  filePath: string;
  fileName: string;
  sha256: string;
  size: number;
  stagedAt: number;
};

export type PeerVersionObservation = {
  peerId: string;
  observedVersion: string;
  observedAt: number;
  triggeredCheck: boolean;
};

export type UpdaterSnapshot = {
  configured: boolean;
  appId: string;
  channel: UpdateChannel;
  currentVersion: string;
  highestAcceptedVersion: string;
  latestCheck: UpdateCheckResult | null;
  staged: StagedUpdateInfo | null;
  peerObservations: PeerVersionObservation[];
};
