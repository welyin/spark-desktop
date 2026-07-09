import { describe, expect, it } from 'vitest';
import { verifyAccess, DOMAIN_SYSTEM, DOMAIN_PLUGIN_PREFIX, DOMAIN_EVIDENCE, pluginDomain } from './domain';

describe('domain access control', () => {
  it('allows system access to any target domain', () => {
    expect(() => verifyAccess(DOMAIN_SYSTEM, 'plugin:test')).not.toThrow();
    expect(() => verifyAccess(DOMAIN_SYSTEM, DOMAIN_EVIDENCE)).not.toThrow();
  });

  it('allows plugin access only to its own domain', () => {
    const plugin = pluginDomain('test');
    expect(() => verifyAccess(plugin, plugin)).not.toThrow();
    expect(() => verifyAccess(plugin, 'plugin:other')).toThrow();
    expect(() => verifyAccess(plugin, DOMAIN_SYSTEM)).toThrow();
  });

  it('rejects evidence domain cross-access', () => {
    expect(() => verifyAccess(DOMAIN_EVIDENCE, DOMAIN_EVIDENCE)).not.toThrow();
    expect(() => verifyAccess(DOMAIN_EVIDENCE, 'plugin:test')).toThrow();
  });

  it('throws for unknown caller domains', () => {
    expect(() => verifyAccess('unknown', 'plugin:test')).toThrow();
  });
});
