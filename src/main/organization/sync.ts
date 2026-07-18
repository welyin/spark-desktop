import type { OrganizationMember, OrganizationNodeInfo, OrganizationRecord, OrganizationSyncState } from './types';

export type OrganizationSyncSection = 'summary' | 'members' | 'member-details' | 'transactions';

export type OrganizationSyncVersions = {
	summaryVersion: number;
	membersVersion: number;
	memberDetailsVersion: number;
	transactionsVersion: number;
};

export type OrganizationTransactionRecord = {
	txId: string;
	orgId: string;
	type: 'create' | 'member-add' | 'member-update' | 'member-remove' | 'delete';
	createdAt: number;
	actorRootId: string;
	targetRootId?: string;
	summary: string;
	payload?: Record<string, unknown>;
};

export type OrganizationSyncSnapshot = {
	orgId: string;
	summary: Pick<OrganizationRecord, 'orgId' | 'name' | 'description' | 'basePluginDomain' | 'createdAt' | 'createdBy' | 'updatedAt'> & {
		memberCount: number;
		adminCount: number;
	};
	members: Array<Pick<OrganizationMember, 'rootId' | 'role' | 'joinedAt' | 'addedBy'> & {
		nodeInfo?: Pick<OrganizationNodeInfo, 'peerId' | 'addresses'>;
	}>;
	transactions: OrganizationTransactionRecord[];
	sync: OrganizationSyncVersions;
};

export function buildOrganizationSyncVersions(record: OrganizationRecord, transactionsVersion = record.updatedAt): OrganizationSyncVersions {
	return {
		summaryVersion: record.updatedAt,
		membersVersion: record.updatedAt,
		memberDetailsVersion: record.updatedAt,
		transactionsVersion
	};
}

export function buildOrganizationSyncSnapshot(record: OrganizationRecord, transactions: OrganizationTransactionRecord[] = []): OrganizationSyncSnapshot {
	const memberCount = record.members.length;
	const adminCount = record.members.filter((member) => member.role === 'admin').length;
	return {
		orgId: record.orgId,
		summary: {
			orgId: record.orgId,
			name: record.name,
			description: record.description,
			basePluginDomain: record.basePluginDomain,
			createdAt: record.createdAt,
			createdBy: record.createdBy,
			updatedAt: record.updatedAt,
			memberCount,
			adminCount
		},
		members: record.members.map((member) => ({
			rootId: member.rootId,
			role: member.role,
			joinedAt: member.joinedAt,
			addedBy: member.addedBy,
			nodeInfo: member.nodeInfo
				? {
					peerId: member.nodeInfo.peerId,
					addresses: member.nodeInfo.addresses
				}
				: undefined
		})),
		transactions,
		sync: buildOrganizationSyncVersions(record, transactions.length > 0 ? transactions[0].createdAt : record.updatedAt)
	};
}

export function mergeOrganizationSyncSnapshot(existing: OrganizationRecord | null, snapshot: OrganizationSyncSnapshot): OrganizationRecord {
	const currentMembers = existing?.members ?? [];
	const incomingMembers = snapshot.members.map((member) => ({
		rootId: member.rootId,
		role: member.role,
		joinedAt: member.joinedAt,
		addedBy: member.addedBy,
		nodeInfo: member.nodeInfo
			? {
				peerId: member.nodeInfo.peerId,
				addresses: member.nodeInfo.addresses
			}
			: undefined
	}));

	const mergedMembersByRootId = new Map<string, OrganizationMember>();
	for (const member of currentMembers) {
		mergedMembersByRootId.set(member.rootId, {
			...member,
			nodeInfo: member.nodeInfo
				? {
					peerId: member.nodeInfo.peerId,
					addresses: member.nodeInfo.addresses
				}
				: undefined
		});
	}

	for (const member of incomingMembers) {
		const existingMember = mergedMembersByRootId.get(member.rootId);
		mergedMembersByRootId.set(member.rootId, {
			...existingMember,
			...member,
			nodeInfo: member.nodeInfo ?? existingMember?.nodeInfo
		});
	}

	const nextRecord: OrganizationRecord = {
		orgId: snapshot.summary.orgId,
		name: snapshot.summary.name,
		description: snapshot.summary.description,
		basePluginDomain: snapshot.summary.basePluginDomain ?? existing?.basePluginDomain,
		createdAt: snapshot.summary.createdAt,
		createdBy: snapshot.summary.createdBy,
		updatedAt: Math.max(existing?.updatedAt ?? 0, snapshot.summary.updatedAt),
		members: [...mergedMembersByRootId.values()],
		sync: {
			versions: snapshot.sync,
			sections: ['summary', 'members', 'member-details', 'transactions'],
			lastSyncedAt: Date.now()
		}
	};

	return nextRecord;
}

export function isOrganizationSyncStale(local: OrganizationSyncVersions | undefined, incoming: OrganizationSyncVersions): boolean {
	if (!local) {
		return true;
	}

	return (
		incoming.summaryVersion > local.summaryVersion ||
		incoming.membersVersion > local.membersVersion ||
		incoming.memberDetailsVersion > local.memberDetailsVersion ||
		incoming.transactionsVersion > local.transactionsVersion
	);
}

export function pickSyncSectionsByPriority(_record: OrganizationRecord): OrganizationSyncSection[] {
	return ['transactions', 'summary', 'members', 'member-details'];
}
