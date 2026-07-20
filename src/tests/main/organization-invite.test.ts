import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { sha256Hex } from '../../main/identity/root-id';
import { OrganizationService } from '../../main/organization';
import { decodeOrgInvite, encodeOrgInvite } from '../../main/organization/invite';
import { buildNodeInfoClaimPayload, type NodeInfoClaim } from '../../main/organization/node-info-claim';

class MemoryDb {
	private readonly store = new Map<string, string>();

	async open(): Promise<void> {}

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async del(key: string): Promise<void> {
		this.store.delete(key);
	}

	async queryRange(options: { prefix: string; start?: string; end?: string }): Promise<Array<{ key: string; value: string }>> {
		return [...this.store.entries()]
			.filter(([key]) => key.startsWith(options.prefix))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => ({ key, value }));
	}
}

function createSignedClaim(nodeInfo: NodeInfoClaim['nodeInfo'] = { peerId: 'QmClaimPeerDemo', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] }): {
	claim: NodeInfoClaim;
	rootId: string;
} {
	const keypair = nacl.sign.keyPair();
	const publicKey = Buffer.from(keypair.publicKey);
	const rootId = sha256Hex(publicKey);
	const unsigned = {
		type: 'spark-node-info-claim' as const,
		version: 1 as const,
		rootId,
		publicKey: publicKey.toString('base64'),
		nodeInfo,
		timestamp: Date.now()
	};
	const signature = nacl.sign.detached(new Uint8Array(Buffer.from(buildNodeInfoClaimPayload(unsigned), 'utf8')), keypair.secretKey);
	return {
		claim: { ...unsigned, signature: Buffer.from(signature).toString('base64') },
		rootId
	};
}

describe('org invite codec', () => {
	it('round-trips a well-formed invite', () => {
		const payload = {
			type: 'spark-org-invite' as const,
			version: 1 as const,
			orgId: 'org_abc123',
			orgName: '产品组',
			inviter: {
				rootId: 'a'.repeat(64),
				peerId: 'QmInviter',
				addresses: ['/ip4/127.0.0.1/tcp/15002/ws']
			},
			createdAt: Date.now()
		};

		const decoded = decodeOrgInvite(encodeOrgInvite(payload));
		expect(decoded).toEqual(payload);
	});

	it('rejects empty, garbled and wrong-type invites with readable errors', () => {
		expect(() => decodeOrgInvite('')).toThrow(/邀请码为空/);
		expect(() => decodeOrgInvite('not-base64-json!!!')).toThrow(/格式不正确/);
		expect(() => decodeOrgInvite(encodeOrgInvite({ type: 'other' } as any))).toThrow(/不是有效的星火组织邀请码/);
	});

	it('rejects invites without any inviter address', () => {
		const encoded = encodeOrgInvite({
			type: 'spark-org-invite',
			version: 1,
			orgId: 'org_abc123',
			orgName: 'x',
			inviter: { rootId: 'a'.repeat(64), addresses: [] },
			createdAt: Date.now()
		});
		expect(() => decodeOrgInvite(encoded)).toThrow(/节点地址/);
	});

	it('rejects expired invites', () => {
		const expired = encodeOrgInvite({
			type: 'spark-org-invite',
			version: 1,
			orgId: 'org_abc123',
			orgName: 'x',
			inviter: { rootId: 'a'.repeat(64), peerId: 'QmInviter', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] },
			createdAt: Date.now() - 25 * 60 * 60 * 1000
		});
		expect(() => decodeOrgInvite(expired)).toThrow(/过期/);
	});
});

describe('OrganizationService invite flow', () => {
	it('restricts invite creation to admins', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		let currentRootId = adminRootId;
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => currentRootId
		}, {}, {
			getLocalNodeInfo: async () => ({ peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] })
		});

		const created = await service.createOrganization({ name: 'Invite Org', basePluginDomain: 'plugin:weibo-core' });
		currentRootId = 'b'.repeat(64);
		await expect(service.createOrgInvite(created.orgId)).rejects.toThrow(/admin/i);
	});

	it('creates an invite carrying inviter node addresses', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {}, {
			getLocalNodeInfo: async () => ({ peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] })
		});

		const created = await service.createOrganization({ name: 'Invite Org', basePluginDomain: 'plugin:weibo-core' });
		const result = await service.createOrgInvite(created.orgId);
		expect(result.orgId).toBe(created.orgId);

		const decoded = decodeOrgInvite(result.invite);
		expect(decoded.orgId).toBe(created.orgId);
		expect(decoded.inviter.rootId).toBe(adminRootId);
		expect(decoded.inviter.peerId).toBe('QmAdmin');
		expect(decoded.inviter.addresses).toEqual(['/ip4/127.0.0.1/tcp/15002/ws']);
	});

	it('rejects invite creation when local node info is unavailable', async () => {
		const db = new MemoryDb();
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => 'a'.repeat(64)
		});

		const created = await service.createOrganization({ name: 'No Net Org', basePluginDomain: 'plugin:weibo-core' });
		await expect(service.createOrgInvite(created.orgId)).rejects.toThrow(/不可用/);
	});

	it('rejects accepting an invite issued by oneself', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {}, {
			getLocalNodeInfo: async () => ({ peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] }),
			connectAndPull: async () => ({ pulled: 0 })
		});

		const created = await service.createOrganization({ name: 'Self Invite Org', basePluginDomain: 'plugin:weibo-core' });
		const { invite } = await service.createOrgInvite(created.orgId);
		await expect(service.acceptOrgInvite(invite)).rejects.toThrow(/自己/);
	});

	it('rejects accepting an expired invite', async () => {
		const db = new MemoryDb();
		const inviteeRootId = 'b'.repeat(64);
		let pulled = 0;
		const inviteeService = new OrganizationService(db, {
			getCurrentRootId: async () => inviteeRootId
		}, {}, {
			connectAndPull: async () => {
				pulled += 1;
				return { pulled: 0 };
			}
		});

		const expiredCode = encodeOrgInvite({
			type: 'spark-org-invite',
			version: 1,
			orgId: 'org_expired_case',
			orgName: 'Old Org',
			inviter: { rootId: 'a'.repeat(64), peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] },
			createdAt: Date.now() - 48 * 60 * 60 * 1000
		});

		await expect(inviteeService.acceptOrgInvite(expiredCode)).rejects.toThrow(/过期/);
		expect(pulled).toBe(0);
	});

	it('accepts an invite by pulling from the inviter and piggybacking the node info claim', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const inviteeRootId = 'b'.repeat(64);

		const adminService = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {}, {
			getLocalNodeInfo: async () => ({ peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] })
		});
		const created = await adminService.createOrganization({ name: 'Pulled Org', basePluginDomain: 'plugin:weibo-core' });
		const { invite } = await adminService.createOrgInvite(created.orgId);

		const selfClaim = { marker: 'self-claim' };
		const pullCalls: Array<{ nodeInfo: unknown; extras: unknown }> = [];
		const inviteeService = new OrganizationService(db, {
			getCurrentRootId: async () => inviteeRootId
		}, {}, {
			connectAndPull: async (nodeInfo, extras) => {
				pullCalls.push({ nodeInfo, extras });
				// 模拟反熵拉取落地：对端快照中包含当前用户（管理员已预录）
				await db.put(`org:meta:${created.orgId}`, JSON.stringify({
					...created,
					members: [
						{ rootId: adminRootId, role: 'admin', joinedAt: 1, addedBy: adminRootId },
						{ rootId: inviteeRootId, role: 'member', joinedAt: 2, addedBy: adminRootId }
					]
				}));
				return { pulled: 1 };
			},
			buildSelfNodeInfoClaim: async () => selfClaim
		});

		const joined = await inviteeService.acceptOrgInvite(invite);
		expect(joined.orgId).toBe(created.orgId);
		expect(joined.orgName).toBe('Pulled Org');
		expect(joined.memberCount).toBe(2);

		expect(pullCalls).toHaveLength(1);
		expect(pullCalls[0]?.nodeInfo).toEqual({
			peerId: 'QmAdmin',
			addresses: ['/ip4/127.0.0.1/tcp/15002/ws']
		});
		expect((pullCalls[0]?.extras as any)?.nodeInfoClaim).toEqual(selfClaim);
	});

	it('fails to accept when the admin has not pre-recorded the invitee', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const inviteeRootId = 'b'.repeat(64);

		const adminService = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {}, {
			getLocalNodeInfo: async () => ({ peerId: 'QmAdmin', addresses: ['/ip4/127.0.0.1/tcp/15002/ws'] })
		});
		const created = await adminService.createOrganization({ name: 'Stranger Org', basePluginDomain: 'plugin:weibo-core' });
		const { invite } = await adminService.createOrgInvite(created.orgId);

		const inviteeService = new OrganizationService(db, {
			getCurrentRootId: async () => inviteeRootId
		}, {}, {
			connectAndPull: async () => {
				// 对端返回的组织里没有当前用户（未预录）
				await db.put(`org:meta:${created.orgId}`, JSON.stringify(created));
				return { pulled: 0 };
			}
		});

		await expect(inviteeService.acceptOrgInvite(invite)).rejects.toThrow(/未能加入组织/);
	});
});

describe('OrganizationService.applyNodeInfoClaim', () => {
	it('applies a member claim, persists node info and fans out the snapshot', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const syncTargets: string[] = [];
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {
			syncOrganizationToMember: async ({ targetRootId }) => {
				syncTargets.push(targetRootId);
			}
		});

		const created = await service.createOrganization({ name: 'Claim Org', basePluginDomain: 'plugin:weibo-core' });
		const { claim, rootId: claimRootId } = createSignedClaim();
		await service.addMember(created.orgId, { rootId: claimRootId });

		const result = await service.applyNodeInfoClaim(claim);
		expect(result.applied).toEqual([created.orgId]);

		const raw = await db.get(`org:meta:${created.orgId}`);
		const record = JSON.parse(raw!);
		const member = record.members.find((item: any) => item.rootId === claimRootId);
		expect(member.nodeInfo).toEqual({
			peerId: 'QmClaimPeerDemo',
			addresses: ['/ip4/127.0.0.1/tcp/15002/ws']
		});
		// 回填后向已知成员 gossip 更新后的快照
		expect(syncTargets).toContain(claimRootId);
	});

	it('ignores claims from root ids that are not members', async () => {
		const db = new MemoryDb();
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => 'a'.repeat(64)
		}, {
			syncOrganizationToMember: async () => {}
		});

		const created = await service.createOrganization({ name: 'Non Member Org', basePluginDomain: 'plugin:weibo-core' });
		const { claim } = createSignedClaim();
		const result = await service.applyNodeInfoClaim(claim);
		expect(result.applied).toEqual([]);
	});

	it('ignores claims when the current user is not an admin', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const { claim, rootId: claimRootId } = createSignedClaim();

		const adminService = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {
			syncOrganizationToMember: async () => {}
		});
		const created = await adminService.createOrganization({ name: 'Member View Org', basePluginDomain: 'plugin:weibo-core' });
		await adminService.addMember(created.orgId, { rootId: claimRootId });

		const memberService = new OrganizationService(db, {
			getCurrentRootId: async () => claimRootId
		});
		const result = await memberService.applyNodeInfoClaim(claim);
		expect(result.applied).toEqual([]);
	});

	it('ignores claims whose peer id does not match the connection', async () => {
		const db = new MemoryDb();
		const adminRootId = 'a'.repeat(64);
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => adminRootId
		}, {
			syncOrganizationToMember: async () => {}
		});

		const created = await service.createOrganization({ name: 'Mismatch Org', basePluginDomain: 'plugin:weibo-core' });
		const { claim, rootId: claimRootId } = createSignedClaim();
		await service.addMember(created.orgId, { rootId: claimRootId });

		const result = await service.applyNodeInfoClaim(claim, { remotePeerId: 'QmSomebodyElse' });
		expect(result.applied).toEqual([]);
	});
});
