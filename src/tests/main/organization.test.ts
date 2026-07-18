import { describe, expect, it } from 'vitest';
import { OrganizationService } from '../../main/organization';

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

describe('OrganizationService', () => {
	it('creates organizations and marks the creator as admin member', async () => {
		const db = new MemoryDb();
		const rootId = 'a'.repeat(64);
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => rootId
		});

		const created = await service.createOrganization({
			name: '  Alpha Org  ',
			description: 'Demo org',
			basePluginDomain: 'plugin:weibo-core'
		});
		expect(created.name).toBe('Alpha Org');
		expect(created.description).toBe('Demo org');
		expect(created.memberCount).toBe(1);
		expect(created.adminCount).toBe(1);
		expect(created.currentUserRole).toBe('admin');
		expect(created.members[0]?.rootId).toBe(rootId);

		const mine = await service.listMine();
		expect(mine).toHaveLength(1);
		expect(mine[0]?.orgId).toBe(created.orgId);
	});

	it('restricts member management and deletion to admins', async () => {
		const db = new MemoryDb();
		let currentRootId = 'b'.repeat(64);
		const syncCalls: Array<{ targetRootId: string }> = [];
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => currentRootId
		}, {
			syncOrganizationToMember: async ({ targetRootId }) => {
				syncCalls.push({ targetRootId });
			}
		});

		const created = await service.createOrganization({ name: 'Team One', basePluginDomain: 'plugin:weibo-core' });
		const memberRootId = 'c'.repeat(64);
		await service.addMember(created.orgId, {
			rootId: memberRootId,
			nodeInfo: {
				peerId: 'QmMemberPeerIdDemo',
				addresses: ['/ip4/127.0.0.1/tcp/15002/ws']
			}
		});
		expect(syncCalls).toHaveLength(1);
		expect(syncCalls[0]?.targetRootId).toBe(memberRootId);

		currentRootId = memberRootId;
		await expect(service.deleteOrganization(created.orgId)).rejects.toThrow(/admin/i);
		await expect(
			service.addMember(created.orgId, {
				rootId: 'd'.repeat(64),
				nodeInfo: {
					peerId: 'QmAnotherPeerDemo',
					addresses: ['/ip4/127.0.0.1/tcp/15003/ws']
				}
			})
		).rejects.toThrow(/admin/i);
		await expect(service.removeMember(created.orgId, 'b'.repeat(64))).rejects.toThrow(/admin/i);

		currentRootId = 'b'.repeat(64);
		const updated = await service.removeMember(created.orgId, memberRootId);
		expect(updated.memberCount).toBe(1);
		expect(updated.adminCount).toBe(1);
	});

	it('prevents removing the last admin from an organization', async () => {
		const db = new MemoryDb();
		const rootId = 'e'.repeat(64);
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => rootId
		});

		const created = await service.createOrganization({ name: 'Guarded Org', basePluginDomain: 'plugin:weibo-core' });
		await expect(service.removeMember(created.orgId, rootId)).rejects.toThrow(/at least one admin/i);
	});

	it('requires member node info and sync callback when adding a member', async () => {
		const db = new MemoryDb();
		const rootId = 'f'.repeat(64);
		const serviceWithoutSync = new OrganizationService(db, {
			getCurrentRootId: async () => rootId
		});

		const created = await serviceWithoutSync.createOrganization({
			name: 'Sync Required Org',
			basePluginDomain: 'plugin:weibo-core'
		});
		await expect(
			serviceWithoutSync.addMember(created.orgId, {
				rootId: '1'.repeat(64),
				nodeInfo: { peerId: 'QmPeerNoSyncDemo', addresses: ['/ip4/127.0.0.1/tcp/15004/ws'] }
			})
		).rejects.toThrow(/not configured/i);

		const serviceWithSync = new OrganizationService(db, {
			getCurrentRootId: async () => rootId
		}, {
			syncOrganizationToMember: async () => {}
		});

		await expect(
			serviceWithSync.addMember(created.orgId, {
				rootId: '2'.repeat(64),
				nodeInfo: { peerId: '', addresses: [] }
			})
		).rejects.toThrow(/node info/i);
	});

	it('requires valid base plugin domain when creating organization', async () => {
		const db = new MemoryDb();
		const rootId = '9'.repeat(64);
		const service = new OrganizationService(db, {
			getCurrentRootId: async () => rootId
		});

		await expect(
			service.createOrganization({
				name: 'Invalid Plugin Org',
				basePluginDomain: ''
			})
		).rejects.toThrow(/base plugin/i);

		await expect(
			service.createOrganization({
				name: 'Invalid Plugin Org',
				basePluginDomain: 'weibo-core'
			})
		).rejects.toThrow(/plugin domain/i);
	});
});
