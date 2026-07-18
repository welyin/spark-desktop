import { describe, expect, it } from 'vitest';
import { buildOrganizationSyncSnapshot, mergeOrganizationSyncSnapshot } from '../../main/organization/sync';
import { normalizeIncomingSnapshot } from '../../main/p2p/org-share-snapshot';
import type { OrganizationRecord } from '../../main/organization';

function createRecord(basePluginDomain?: string): OrganizationRecord {
  return {
    orgId: 'org_sync_test',
    name: 'Sync Org',
    description: 'sync case',
    basePluginDomain,
    createdAt: 1,
    createdBy: 'a'.repeat(64),
    updatedAt: 2,
    members: [
      {
        rootId: 'a'.repeat(64),
        role: 'admin',
        joinedAt: 1,
        addedBy: 'a'.repeat(64)
      }
    ]
  };
}

describe('organization sync snapshot', () => {
  it('includes base plugin domain in built snapshot', () => {
    const record = createRecord('plugin:weibo-core');
    const snapshot = buildOrganizationSyncSnapshot(record);

    expect(snapshot.summary.basePluginDomain).toBe('plugin:weibo-core');
  });

  it('preserves base plugin domain when merging incoming snapshot', () => {
    const existing = createRecord(undefined);
    const incoming = buildOrganizationSyncSnapshot(createRecord('plugin:weibo-core'));

    const merged = mergeOrganizationSyncSnapshot(existing, incoming);

    expect(merged.basePluginDomain).toBe('plugin:weibo-core');
  });

  it('normalizes incoming organization records with base plugin domain', () => {
    const normalized = normalizeIncomingSnapshot({
      orgId: 'org_sync_test',
      name: 'Sync Org',
      description: 'sync case',
      basePluginDomain: 'plugin:weibo-core',
      createdAt: 1,
      createdBy: 'a'.repeat(64),
      updatedAt: 2,
      members: [
        {
          rootId: 'a'.repeat(64),
          role: 'admin',
          joinedAt: 1,
          addedBy: 'a'.repeat(64)
        }
      ]
    });

    expect(normalized.summary.basePluginDomain).toBe('plugin:weibo-core');
  });
});
