import { randomBytes } from 'crypto';
import { ORG_META_PREFIX } from './constants';
import { appendOrganizationTransaction, listOrganizationTransactions } from './transaction-store';
import { buildOrganizationSyncVersions, pickSyncSectionsByPriority } from './sync';
import type { CreateOrganizationInput, OrganizationDb, OrganizationMember, OrganizationNodeInfo, OrganizationRecord, OrganizationSyncContext, OrganizationTransactionRecord, OrganizationView, RootIdentityContext, OrganizationRole } from './types';

function organizationKey(orgId: string): string {
	return `${ORG_META_PREFIX}${orgId}`;
}

function normalizeText(value: string, label: string): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (!normalized) {
		throw new Error(`${label} is required`);
	}
	return normalized;
}

function normalizePluginDomain(value: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error('Base plugin is required');
	}

	if (!normalized.startsWith('plugin:') || normalized.length <= 'plugin:'.length) {
		throw new Error('Invalid base plugin domain');
	}

	return normalized;
}

function normalizeRootId(rootId: string): string {
	const normalized = rootId.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(normalized)) {
		throw new Error('Invalid member rootId');
	}
	return normalized;
}

function parseRecord(raw: string): OrganizationRecord {
	return JSON.parse(raw) as OrganizationRecord;
}

function normalizeNodeInfo(nodeInfo: OrganizationNodeInfo): OrganizationNodeInfo {
	const peerId = nodeInfo.peerId?.trim();
	const addresses = nodeInfo.addresses
		.map((item) => item.trim())
		.filter((item) => item.length > 0);

	if (!peerId && addresses.length === 0) {
		throw new Error('Member node info is required: provide peerId or at least one address');
	}

	if (peerId && peerId.length < 8) {
		throw new Error('Invalid peerId');
	}

	return {
		peerId: peerId || undefined,
		addresses
	};
}

function sortMembers(members: OrganizationMember[]): OrganizationMember[] {
	return [...members].sort((left, right) => {
		if (left.role !== right.role) {
			return left.role === 'admin' ? -1 : 1;
		}
		return left.joinedAt - right.joinedAt;
	});
}

function generateOrganizationId(): string {
	return `org_${randomBytes(8).toString('hex')}`;
}

export class OrganizationService {
	constructor(
		private readonly db: OrganizationDb,
		private readonly rootIdentity: RootIdentityContext,
		private readonly syncContext: OrganizationSyncContext = {}
	) {}

	async listMine(): Promise<OrganizationView[]> {
		const currentRootId = await this.requireCurrentRootId();
		await this.db.open();
		const records = await this.readAllOrganizations();
		return records
			.filter((record) => record.members.some((member) => member.rootId === currentRootId))
			.map((record) => this.toView(record, currentRootId))
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async createOrganization(input: CreateOrganizationInput): Promise<OrganizationView> {
		const currentRootId = await this.requireCurrentRootId();
		const name = normalizeText(input.name, 'Organization name');
		const description = input.description ? input.description.trim() : '';
		const basePluginDomain = normalizePluginDomain(input.basePluginDomain);
		const now = Date.now();
		const record: OrganizationRecord = {
			orgId: generateOrganizationId(),
			name,
			description,
			basePluginDomain,
			createdAt: now,
			createdBy: currentRootId,
			updatedAt: now,
			members: [
				{
					rootId: currentRootId,
					role: 'admin',
					joinedAt: now,
					addedBy: currentRootId
				}
			]
		};
		const transaction = await appendOrganizationTransaction(this.db, {
			orgId: record.orgId,
			type: 'create',
			actorRootId: currentRootId,
			summary: `创建组织 ${name}`,
			payload: { name, description, basePluginDomain }
		});
		record.sync = {
			versions: buildOrganizationSyncVersions(record, transaction.createdAt),
			sections: pickSyncSectionsByPriority(record),
			lastSyncedAt: 0
		};

		await this.db.open();
		await this.db.put(organizationKey(record.orgId), JSON.stringify(record));
		return this.toView(record, currentRootId);
	}

	async deleteOrganization(orgId: string): Promise<{ success: boolean }> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);
		await appendOrganizationTransaction(this.db, {
			orgId,
			type: 'delete',
			actorRootId: currentRootId,
			summary: `删除组织 ${record.name}`,
			payload: { orgId }
		});

		await this.db.open();
		await this.db.del(organizationKey(orgId));
		return { success: true };
	}

	async addMember(orgId: string, input: { rootId: string; nodeInfo: OrganizationNodeInfo }): Promise<OrganizationView> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);

		const normalizedMemberRootId = normalizeRootId(input.rootId);
		const normalizedNodeInfo = normalizeNodeInfo(input.nodeInfo);
		const existingMember = record.members.find((member) => member.rootId === normalizedMemberRootId);
		if (existingMember) {
			const updatedMember: OrganizationMember = {
				...existingMember,
				nodeInfo: normalizedNodeInfo
			};

			const updatedRecord: OrganizationRecord = {
				...record,
				updatedAt: Date.now(),
				members: record.members.map((member) =>
					member.rootId === normalizedMemberRootId ? updatedMember : member
				)
			};
			const transaction = await appendOrganizationTransaction(this.db, {
				orgId,
				type: 'member-update',
				actorRootId: currentRootId,
				targetRootId: normalizedMemberRootId,
				summary: `更新成员节点信息 ${normalizedMemberRootId}`,
				payload: { nodeInfo: normalizedNodeInfo }
			});
			updatedRecord.sync = {
				versions: buildOrganizationSyncVersions(updatedRecord, transaction.createdAt),
				sections: pickSyncSectionsByPriority(updatedRecord),
				lastSyncedAt: record.sync?.lastSyncedAt ?? 0
			};

			if (!this.syncContext.syncOrganizationToMember) {
				throw new Error('P2P organization sync is not configured');
			}

			await this.syncOrganizationToKnownMembers(updatedRecord, currentRootId, normalizedMemberRootId);
			console.log('[org] member sync published', {
				orgId,
				targetRootId: normalizedMemberRootId,
				reason: 'member-exists-update-node-info'
			});

			await this.db.open();
			await this.db.put(organizationKey(orgId), JSON.stringify(updatedRecord));
			return this.toView(updatedRecord, currentRootId);
		}

		const newMember: OrganizationMember = {
			rootId: normalizedMemberRootId,
			role: 'member',
			joinedAt: Date.now(),
			addedBy: currentRootId,
			nodeInfo: normalizedNodeInfo
		};

		const updatedRecord: OrganizationRecord = {
			...record,
			updatedAt: Date.now(),
			members: [...record.members, newMember]
		};
		const transaction = await appendOrganizationTransaction(this.db, {
			orgId,
			type: 'member-add',
			actorRootId: currentRootId,
			targetRootId: normalizedMemberRootId,
			summary: `添加成员 ${normalizedMemberRootId}`,
			payload: { nodeInfo: normalizedNodeInfo }
		});
		updatedRecord.sync = {
			versions: buildOrganizationSyncVersions(updatedRecord, transaction.createdAt),
			sections: pickSyncSectionsByPriority(updatedRecord),
			lastSyncedAt: record.sync?.lastSyncedAt ?? 0
		};

		if (!this.syncContext.syncOrganizationToMember) {
			throw new Error('P2P organization sync is not configured');
		}

		await this.syncOrganizationToKnownMembers(updatedRecord, currentRootId, normalizedMemberRootId);
		console.log('[org] member sync published', {
			orgId,
			targetRootId: normalizedMemberRootId,
			reason: 'new-member-added'
		});

		await this.db.open();
		await this.db.put(organizationKey(orgId), JSON.stringify(updatedRecord));
		return this.toView(updatedRecord, currentRootId);
	}

	async removeMember(orgId: string, memberRootId: string): Promise<OrganizationView> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);

		const normalizedMemberRootId = normalizeRootId(memberRootId);
		const memberIndex = record.members.findIndex((member) => member.rootId === normalizedMemberRootId);
		if (memberIndex < 0) {
			throw new Error('Member not found');
		}

		const member = record.members[memberIndex];
		if (member.role === 'admin') {
			const adminCount = record.members.filter((item) => item.role === 'admin').length;
			if (adminCount <= 1) {
				throw new Error('Organization must keep at least one admin');
			}
		}

		record.members.splice(memberIndex, 1);
		record.updatedAt = Date.now();
		const transaction = await appendOrganizationTransaction(this.db, {
			orgId,
			type: 'member-remove',
			actorRootId: currentRootId,
			targetRootId: normalizedMemberRootId,
			summary: `移除成员 ${normalizedMemberRootId}`,
			payload: { removedRole: member.role }
		});
		record.sync = {
			versions: buildOrganizationSyncVersions(record, transaction.createdAt),
			sections: pickSyncSectionsByPriority(record),
			lastSyncedAt: record.sync?.lastSyncedAt ?? 0
		};

		await this.db.open();
		await this.db.put(organizationKey(orgId), JSON.stringify(record));
		return this.toView(record, currentRootId);
	}

	async listTransactions(orgId: string, limit = 20): Promise<OrganizationTransactionRecord[]> {
		return await listOrganizationTransactions(this.db, orgId, limit);
	}

	private async readAllOrganizations(): Promise<OrganizationRecord[]> {
		const rows = await this.db.queryRange({
			prefix: ORG_META_PREFIX,
			start: ORG_META_PREFIX,
			end: `${ORG_META_PREFIX}\xFF`
		});
		return rows.map((row) => parseRecord(row.value));
	}

	private async requireOrganization(orgId: string): Promise<OrganizationRecord> {
		await this.db.open();
		const raw = await this.db.get(organizationKey(orgId));
		if (!raw) {
			throw new Error('Organization not found');
		}
		return parseRecord(raw);
	}

	private requireAdmin(record: OrganizationRecord, rootId: string): void {
		const member = record.members.find((item) => item.rootId === rootId);
		if (!member || member.role !== 'admin') {
			throw new Error('Organization admin required');
		}
	}

	private async requireCurrentRootId(): Promise<string> {
		const rootId = await this.rootIdentity.getCurrentRootId();
		if (!rootId) {
			throw new Error('Root identity is locked');
		}
		return rootId;
	}

	private async syncOrganizationToKnownMembers(record: OrganizationRecord, actorRootId: string, requiredTargetRootId: string): Promise<void> {
		if (!this.syncContext.syncOrganizationToMember) {
			throw new Error('P2P organization sync is not configured');
		}

		const recipients = record.members.filter((member) => {
			if (member.rootId === actorRootId) {
				return false;
			}
			const nodeInfo = member.nodeInfo;
			if (!nodeInfo) {
				return false;
			}
			return Boolean((nodeInfo.peerId && nodeInfo.peerId.trim().length > 0) || nodeInfo.addresses.length > 0);
		});

		for (const member of recipients) {
			const isRequiredTarget = member.rootId === requiredTargetRootId;
			try {
				await this.syncContext.syncOrganizationToMember({
					organization: record,
					member,
					targetRootId: member.rootId
				});
			} catch (error) {
				if (isRequiredTarget) {
					throw error;
				}
				console.warn('[org] best-effort member sync failed', {
					orgId: record.orgId,
					targetRootId: member.rootId,
					error: String(error)
				});
			}
		}
	}

	private toView(record: OrganizationRecord, currentRootId: string): OrganizationView {
		const members = sortMembers(record.members);
		const currentMember = members.find((member) => member.rootId === currentRootId) ?? null;
		const adminCount = members.filter((member) => member.role === 'admin').length;

		return {
			...record,
			basePluginDomain: record.basePluginDomain ?? '',
			members,
			currentUserRole: currentMember?.role ?? null,
			isCurrentUserAdmin: currentMember?.role === 'admin',
			memberCount: members.length,
			adminCount
		};
	}
}
