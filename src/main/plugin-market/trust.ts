import type { PluginTrustConfig } from './types';

const DEFAULT_PLUGIN_PUBLIC_KEYS_PEM = [
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

export function getPluginTrustConfig(): PluginTrustConfig {
  const fromEnv = splitKeys(resolveEnv('SPARK_PLUGIN_UPDATE_PUBLIC_KEY_PEM'));
  return {
    publicKeysPem: fromEnv.length > 0 ? fromEnv : DEFAULT_PLUGIN_PUBLIC_KEYS_PEM
  };
}
