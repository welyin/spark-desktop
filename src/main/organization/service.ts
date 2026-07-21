import { randomBytes } from 'crypto';
import { ORG_META_PREFIX } from './constants';
import { appendOrganizationTransaction, listOrganizationTransactions } from './transaction-store';
import { buildOrganizationSyncVersions, pickSyncSectionsByPriority } from './sync';
import { decodeOrgInvite, encodeOrgInvite } from './invite';
import { NodeInfoClaim, verifyNodeInfoClaim } from './node-info-claim';
import type { CreateOrganizationInput, OrganizationDb, OrganizationInviteContext, OrganizationMember, OrganizationNodeInfo, OrganizationRecord, OrganizationSyncContext, OrganizationTransactionRecord, OrganizationView, RootIdentityContext, OrganizationRole } from './types';

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

/** 可选 nodeInfo 归一化：未提供或全空视为 undefined（成员地址可后续经 nodeInfoClaim 回填） */
function normalizeOptionalNodeInfo(nodeInfo?: OrganizationNodeInfo | null): OrganizationNodeInfo | undefined {
	if (!nodeInfo) {
		return undefined;
	}
	const hasPeerId = Boolean(nodeInfo.peerId?.trim());
	const hasAddresses = Array.isArray(nodeInfo.addresses) && nodeInfo.addresses.some((item) => item.trim().length > 0);
	if (!hasPeerId && !hasAddresses) {
		return undefined;
	}
	return normalizeNodeInfo(nodeInfo);
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
		private readonly syncContext: OrganizationSyncContext = {},
		private readonly inviteContext: OrganizationInviteContext = {}
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
			recoverySecret: randomBytes(32).toString('hex'),
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

	/**
	 * 组织恢复视图：返回当前用户为成员的组织的恢复参数（orgId + 恢复盐 + 成员地址）。
	 * 供覆盖网 org-recovery 协议计算查询 token 与应答命中查询。
	 * 存量组织缺 recoverySecret 时由管理员惰性补齐：bump updatedAt 后落库，
	 * 经既有反熵拉取扩散给其他成员（恢复盐不在保留字段中，随 summary.metadata 流动）。
	 */
	async getRecoveryView(): Promise<Array<{ orgId: string; recoverySecret: string; memberNodeInfos: OrganizationNodeInfo[] }>> {
		const currentRootId = await this.rootIdentity.getCurrentRootId();
		if (!currentRootId) {
			return [];
		}

		await this.db.open();
		const records = await this.readAllOrganizations();
		const view: Array<{ orgId: string; recoverySecret: string; memberNodeInfos: OrganizationNodeInfo[] }> = [];
		for (const record of records) {
			const self = record.members.find((member) => member.rootId === currentRootId);
			if (!self) {
				continue;
			}

			if (!record.recoverySecret) {
				// 非管理员等管理员补齐后经 gossip 获得；本轮先跳过
				if (self.role !== 'admin') {
					continue;
				}
				record.recoverySecret = randomBytes(32).toString('hex');
				record.updatedAt = Date.now();
				record.sync = {
					versions: buildOrganizationSyncVersions(record, record.sync?.versions?.transactionsVersion ?? record.updatedAt),
					sections: pickSyncSectionsByPriority(record),
					lastSyncedAt: record.sync?.lastSyncedAt ?? 0
				};
				await this.db.put(organizationKey(record.orgId), JSON.stringify(record));
			}

			view.push({
				orgId: record.orgId,
				recoverySecret: record.recoverySecret,
				memberNodeInfos: record.members
					.filter((member) => (member.nodeInfo?.addresses?.length ?? 0) > 0)
					.map((member) => member.nodeInfo as OrganizationNodeInfo)
			});
		}
		return view;
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

	async addMember(orgId: string, input: { rootId: string; nodeInfo?: OrganizationNodeInfo }): Promise<OrganizationView> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);

		const normalizedMemberRootId = normalizeRootId(input.rootId);
		const normalizedNodeInfo = normalizeOptionalNodeInfo(input.nodeInfo);
		const existingMember = record.members.find((member) => member.rootId === normalizedMemberRootId);
		if (existingMember) {
			const updatedMember: OrganizationMember = {
				...existingMember,
				// 未提供 nodeInfo 时保留原值，避免管理员重复添加时清空已回填的地址
				nodeInfo: normalizedNodeInfo ?? existingMember.nodeInfo
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

	/**
	 * 生成组织邀请码（仅管理员）。
	 * 邀请码携带邀请人节点地址，被邀请人凭码直连本节点拉取组织数据。
	 */
	async createOrgInvite(orgId: string): Promise<{ invite: string; orgId: string; orgName: string }> {
		const currentRootId = await this.requireCurrentRootId();
		const record = await this.requireOrganization(orgId);
		this.requireAdmin(record, currentRootId);

		if (!this.inviteContext.getLocalNodeInfo) {
			throw new Error('P2P 节点信息不可用，无法生成邀请码');
		}
		const local = await this.inviteContext.getLocalNodeInfo();
		const peerId = local.peerId?.trim() || undefined;
		const addresses = (local.addresses ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
		if (!peerId && addresses.length === 0) {
			throw new Error('本机 P2P 节点尚未启动，请先启动网络后再生成邀请码');
		}

		const invite = encodeOrgInvite({
			type: 'spark-org-invite',
			version: 1,
			orgId: record.orgId,
			orgName: record.name,
			inviter: { rootId: currentRootId, peerId, addresses },
			createdAt: Date.now()
		});
		return { invite, orgId: record.orgId, orgName: record.name };
	}

	/**
	 * 接受组织邀请：连接邀请人节点并反熵拉取。
	 * 成功前提是管理员已预录当前用户的 RootID（邀请码本身不是加入凭证）。
	 */
	async acceptOrgInvite(code: string): Promise<{ orgId: string; orgName: string; memberCount: number }> {
		const currentRootId = await this.requireCurrentRootId();
		const payload = decodeOrgInvite(code);

		if (payload.inviter.rootId === currentRootId) {
			throw new Error('不能接受自己发出的邀请码');
		}
		if (!this.inviteContext.connectAndPull) {
			throw new Error('P2P 网络能力不可用，无法通过邀请码加入');
		}

		const nodeInfoClaim = this.inviteContext.buildSelfNodeInfoClaim
			? ((await this.inviteContext.buildSelfNodeInfoClaim()) ?? undefined)
			: undefined;

		await this.inviteContext.connectAndPull(
			{ peerId: payload.inviter.peerId, addresses: payload.inviter.addresses },
			{ nodeInfoClaim }
		);

		await this.db.open();
		const raw = await this.db.get(organizationKey(payload.orgId));
		const record = raw ? parseRecord(raw) : null;
		const isMember = record?.members?.some((member) => member.rootId === currentRootId);
		if (!record || !isMember) {
			throw new Error('未能加入组织：请确认管理员已先将你的 RootID 录入组织成员');
		}

		return { orgId: record.orgId, orgName: record.name, memberCount: record.members.length };
	}

	/**
	 * 校验并应用成员上报的节点地址声明（nodeInfoClaim）。
	 * 仅当本机当前用户是某组织管理员且声明者是该组织成员时落库，
	 * 随后经组织快照 gossip 把新地址带给其他成员。
	 */
	async applyNodeInfoClaim(claim: NodeInfoClaim, context: { remotePeerId?: string } = {}): Promise<{ applied: string[] }> {
		const currentRootId = await this.rootIdentity.getCurrentRootId();
		if (!currentRootId) {
			return { applied: [] };
		}

		const verification = verifyNodeInfoClaim(claim);
		if (!verification.ok) {
			console.warn('[org] ignore invalid node info claim', { reason: verification.reason, rootId: claim?.rootId });
			return { applied: [] };
		}

		if (context.remotePeerId && claim.nodeInfo.peerId && claim.nodeInfo.peerId !== context.remotePeerId) {
			console.warn('[org] ignore node info claim: peerId does not match connection', {
				rootId: claim.rootId,
				claimed: claim.nodeInfo.peerId,
				actual: context.remotePeerId
			});
			return { applied: [] };
		}

		const claimRootId = claim.rootId.trim().toLowerCase();
		const claimedNodeInfo = normalizeOptionalNodeInfo(claim.nodeInfo);
		if (!claimedNodeInfo) {
			return { applied: [] };
		}

		const applied: string[] = [];
		const records = await this.readAllOrganizations();
		for (const record of records) {
			const adminMember = record.members.find((member) => member.rootId === currentRootId && member.role === 'admin');
			if (!adminMember) {
				continue;
			}
			const member = record.members.find((item) => item.rootId === claimRootId);
			if (!member) {
				continue;
			}

			const unchanged =
				member.nodeInfo?.peerId === claimedNodeInfo.peerId &&
				JSON.stringify(member.nodeInfo?.addresses ?? []) === JSON.stringify(claimedNodeInfo.addresses);
			if (unchanged) {
				continue;
			}

			const updatedRecord: OrganizationRecord = {
				...record,
				updatedAt: Date.now(),
				members: record.members.map((item) => (item.rootId === claimRootId ? { ...item, nodeInfo: claimedNodeInfo } : item))
			};
			const transaction = await appendOrganizationTransaction(this.db, {
				orgId: record.orgId,
				type: 'member-update',
				actorRootId: claimRootId,
				targetRootId: claimRootId,
				summary: `成员节点地址自动回填 ${claimRootId.slice(0, 8)}`,
				payload: { nodeInfo: claimedNodeInfo, source: 'node-info-claim' }
			});
			updatedRecord.sync = {
				versions: buildOrganizationSyncVersions(updatedRecord, transaction.createdAt),
				sections: pickSyncSectionsByPriority(updatedRecord),
				lastSyncedAt: record.sync?.lastSyncedAt ?? 0
			};

			await this.db.open();
			await this.db.put(organizationKey(record.orgId), JSON.stringify(updatedRecord));

			// 把更新后的快照推给其他已知成员（尽力而为），加速地址传播
			if (this.syncContext.syncOrganizationToMember) {
				await this.syncOrganizationToKnownMembers(updatedRecord, currentRootId, claimRootId);
			}
			applied.push(record.orgId);
			console.log('[org] member node info updated from claim', { orgId: record.orgId, rootId: claimRootId });
		}

		return { applied };
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
			try {
				await this.syncContext.syncOrganizationToMember({
					organization: record,
					member,
					targetRootId: member.rootId
				});
			} catch (error) {
				// 预录模型：成员离线不再视为失败。对方凭邀请码上线后自会回拉，
				// 同步状态经 K 副本概览呈现（requiredTargetRootId 仅用于日志标注）
				console.warn('[org] member sync deferred (peer unreachable)', {
					orgId: record.orgId,
					targetRootId: member.rootId,
					isNewMember: member.rootId === requiredTargetRootId,
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
