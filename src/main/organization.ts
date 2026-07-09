import { randomBytes } from 'crypto';

export type OrganizationRole = 'admin' | 'member';

export type OrganizationMember = {
	rootId: string;
	role: OrganizationRole;
	joinedAt: number;
	addedBy: string;
};

export type OrganizationRecord = {
	orgId: string;
	name: string;
	description: string;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
	members: OrganizationMember[];
};

export type OrganizationView = OrganizationRecord & {
	currentUserRole: OrganizationRole | null;
	isCurrentUserAdmin: boolean;
	memberCount: number;
	adminCount: number;
};

type OrganizationDb = {
	open: () => Promise<void>;
	get: (key: string) => Promise<string | null>;
	put: (key: string, value: string) => Promise<void>;
	del: (key: string) => Promise<void>;
	queryRange: (options: { prefix: string; start?: string; end?: string }) => Promise<Array<{ key: string; value: string }>>;
};

type RootIdentityContext = {
	getCurrentRootId: () => Promise<string | null>;
};

type CreateOrganizationInput = {
	name: string;
	description?: string;
};

const ORG_META_PREFIX = 'org:meta:';

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
		private readonly rootIdentity: RootIdentityContext
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
		const now = Date.now();
		const record: OrganizationRecord = {
			orgId: generateOrganizationId(),
			name,
			description,
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

		await this.db.open();
		await this.db.put(organizationKey(record.orgId), JSON.stringify(record));
		return this.toView(record, currentRootId);
	}

	async deleteOrganization(orgId: string): Promise<{ success: boolean }> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);

		await this.db.open();
		await this.db.del(organizationKey(orgId));
		return { success: true };
	}

	async addMember(orgId: string, memberRootId: string): Promise<OrganizationView> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);

		const normalizedMemberRootId = normalizeRootId(memberRootId);
		const existingMember = record.members.find((member) => member.rootId === normalizedMemberRootId);
		if (existingMember) {
			return this.toView(record, currentRootId);
		}

		record.members.push({
			rootId: normalizedMemberRootId,
			role: 'member',
			joinedAt: Date.now(),
			addedBy: currentRootId
		});
		record.updatedAt = Date.now();

		await this.db.open();
		await this.db.put(organizationKey(orgId), JSON.stringify(record));
		return this.toView(record, currentRootId);
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

		await this.db.open();
		await this.db.put(organizationKey(orgId), JSON.stringify(record));
		return this.toView(record, currentRootId);
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

	private toView(record: OrganizationRecord, currentRootId: string): OrganizationView {
		const members = sortMembers(record.members);
		const currentMember = members.find((member) => member.rootId === currentRootId) ?? null;
		const adminCount = members.filter((member) => member.role === 'admin').length;

		return {
			...record,
			members,
			currentUserRole: currentMember?.role ?? null,
			isCurrentUserAdmin: currentMember?.role === 'admin',
			memberCount: members.length,
			adminCount
		};
	}
}
