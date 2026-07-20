export type OrganizationRole = 'admin' | 'member';

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
	basePluginDomain?: string;
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

/**
 * 邀请流程所需的网络能力（由装配层注入，避免 organization 层硬依赖 p2p）
 * - getLocalNodeInfo：本机节点地址（生成邀请码）
 * - connectAndPull：连接邀请人并反熵拉取（接受邀请），可捎带 nodeInfoClaim 回填本机地址
 */
export type OrganizationInviteContext = {
	getLocalNodeInfo?: () => Promise<{ peerId: string | null; addresses: string[] }>;
	connectAndPull?: (nodeInfo: OrganizationNodeInfo, extras?: { nodeInfoClaim?: unknown }) => Promise<{ pulled: number }>;
	buildSelfNodeInfoClaim?: () => Promise<unknown | null>;
};

export type CreateOrganizationInput = {
	name: string;
	description?: string;
	basePluginDomain: string;
};
