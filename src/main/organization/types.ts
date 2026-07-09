export type OrganizationRole = 'admin' | 'member';

export type OrganizationNodeInfo = {
	peerId?: string;
	addresses: string[];
};

export type OrganizationMember = {
	rootId: string;
	role: OrganizationRole;
	joinedAt: number;
	addedBy: string;
	nodeInfo?: OrganizationNodeInfo;
};

export type OrganizationSyncState = {
	versions: {
		summaryVersion: number;
		membersVersion: number;
		memberDetailsVersion: number;
		transactionsVersion: number;
	};
	sections: Array<'summary' | 'members' | 'member-details' | 'transactions'>;
	lastSyncedAt: number;
};

export type OrganizationRecord = {
	orgId: string;
	name: string;
	description: string;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
	members: OrganizationMember[];
	sync?: OrganizationSyncState;
};

export type OrganizationView = OrganizationRecord & {
	currentUserRole: OrganizationRole | null;
	isCurrentUserAdmin: boolean;
	memberCount: number;
	adminCount: number;
};

export type OrganizationDb = {
	open: () => Promise<void>;
	get: (key: string) => Promise<string | null>;
	put: (key: string, value: string) => Promise<void>;
	del: (key: string) => Promise<void>;
	queryRange: (options: { prefix: string; start?: string; end?: string }) => Promise<Array<{ key: string; value: string }>>;
};

export type RootIdentityContext = {
	getCurrentRootId: () => Promise<string | null>;
};

export type OrganizationSyncContext = {
	syncOrganizationToMember?: (payload: {
		organization: OrganizationRecord;
		member: OrganizationMember;
		targetRootId: string;
	}) => Promise<void>;
};

export type CreateOrganizationInput = {
	name: string;
	description?: string;
};
