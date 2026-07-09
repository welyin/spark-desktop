import type { LevelDB } from '../db/base';
import { ORG_META_PREFIX } from '../organization';
import type { OrganizationRecord } from '../organization';
import type { PeerNodeInfo } from './types';

type SyncOrganizationFn = (nodeInfo: PeerNodeInfo, targetRootId: string, organization: OrganizationRecord) => Promise<void>;

type BootstrapOrgSyncDeps = {
  db: LevelDB;
  currentRootId: string;
  targetPeer: PeerNodeInfo;
  syncOrganizationToMember: SyncOrganizationFn;
};

function parseOrganizationRecord(raw: string): OrganizationRecord | null {
  try {
    return JSON.parse(raw) as OrganizationRecord;
  } catch {
    return null;
  }
}

function priorityScore(record: OrganizationRecord): number {
  const transactionVersion = record.sync?.versions.transactionsVersion ?? 0;
  const memberCount = record.members.length;
  return transactionVersion + memberCount * 10;
}

function onlyRelatedOrganizations(records: OrganizationRecord[], currentRootId: string): OrganizationRecord[] {
  return records.filter((record) => record.members.some((member) => member.rootId === currentRootId));
}

export async function syncCurrentRootOrganizationsToPeer(deps: BootstrapOrgSyncDeps): Promise<{ attempted: number; synced: number }> {
  const rows = await deps.db.queryRange({
    prefix: ORG_META_PREFIX,
    start: ORG_META_PREFIX,
    end: `${ORG_META_PREFIX}\xFF`
  });

  const organizations = onlyRelatedOrganizations(
    rows
      .map((row) => parseOrganizationRecord(row.value))
      .filter((item): item is OrganizationRecord => item !== null),
    deps.currentRootId
  ).sort((left, right) => priorityScore(right) - priorityScore(left));

  let synced = 0;
  for (const organization of organizations) {
    await deps.syncOrganizationToMember(deps.targetPeer, deps.currentRootId, organization);
    synced += 1;
  }

  return {
    attempted: organizations.length,
    synced
  };
}
