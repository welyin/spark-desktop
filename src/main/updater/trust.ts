import type { UpdateChannel } from './types';

export type UpdateTrustConfig = {
  appId: string;
  channel: UpdateChannel;
  manifestUrl: string;
  signatureUrl: string;
  publicKeysPem: string[];
};

const DEFAULT_PUBLIC_KEYS_PEM = [
  [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAEIZeVVpcZ4HdWRzYhxNcXRNOH56yhcP8QQnAjvZSHBY=',
    '-----END PUBLIC KEY-----'
  ].join('\n')
];

function resolveEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitKeys(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split('@@')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function getUpdateTrustConfig(): UpdateTrustConfig {
  const appId = resolveEnv('SPARK_UPDATE_APP_ID') ?? 'spark-desktop';
  const channel = (resolveEnv('SPARK_UPDATE_CHANNEL') as UpdateChannel | null) ?? 'stable';

  const manifestUrl =
    resolveEnv('SPARK_UPDATE_MANIFEST_URL') ??
    'https://github.com/welyin/spark-desktop/releases/latest/download/spark-manifest.json';
  const signatureUrl =
    resolveEnv('SPARK_UPDATE_SIGNATURE_URL') ??
    'https://github.com/welyin/spark-desktop/releases/latest/download/spark-manifest.sig';

  const inlineKey = resolveEnv('SPARK_UPDATE_PUBLIC_KEY_PEM');
  const keysFromEnv = splitKeys(inlineKey);
  const keys = keysFromEnv.length > 0 ? keysFromEnv : DEFAULT_PUBLIC_KEYS_PEM;

  return {
    appId,
    channel,
    manifestUrl,
    signatureUrl,
    publicKeysPem: keys
  };
}
