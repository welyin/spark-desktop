import { buildOrganizationSyncSnapshot, type OrganizationSyncSnapshot } from '../organization/sync';
import type { OrganizationRecord } from '../organization';

export function normalizeIncomingSnapshot(organization: any): OrganizationSyncSnapshot {
  if (organization?.summary && organization?.sync && Array.isArray(organization?.members)) {
    return organization as OrganizationSyncSnapshot;
  }

  const record: OrganizationRecord = {
    ...(organization as Record<string, unknown>),
    orgId: organization.orgId,
    name: organization.name,
    description: organization.description,
    basePluginDomain: organization.basePluginDomain,
    createdAt: organization.createdAt,
    createdBy: organization.createdBy,
    updatedAt: organization.updatedAt,
    members: Array.isArray(organization.members) ? organization.members : [],
    sync: organization.sync
  };

  return buildOrganizationSyncSnapshot(record, Array.isArray(organization.transactions) ? organization.transactions : []);
}
