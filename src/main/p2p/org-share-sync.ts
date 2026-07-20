import crypto from 'crypto';
import type { LevelDB } from '../db/base';
import { DIRECT_ORG_SHARE_PROTOCOL, ORG_META_PREFIX, ORG_REPLICA_FRESH_WINDOW_MS, ORG_REPLICA_TARGET } from './constants';
import { buildDialTargets, extractPeerId } from './peer-targets';
import { buildOrganizationSyncSnapshot, buildOrganizationSyncVersions, isOrganizationSyncStale, mergeOrganizationSyncSnapshot, type OrganizationSyncSnapshot, type OrganizationSyncVersions } from '../organization/sync';
import { OrgShareSessionState } from './org-share-session';
import { OrgPullSyncService } from './org-pull-sync';
import { normalizeIncomingSnapshot } from './org-share-snapshot';
import { applyPluginDocSyncItems, collectSyncablePluginDocsByOrg } from './plugin-org-sync';
import { parseJsonSafely, readStreamAsString, resolveProtocolStream, writeStringToStream } from './stream-utils';
import type { P2PIdentityContext, PeerNodeInfo } from './types';

type RuntimeImport = (specifier: string) => Promise<any>;

/**
 * org-share 服务依赖项。
 * 通过函数注入访问 node、连接与广播能力，避免直接依赖 P2PNode 实例细节。
 */
type OrgShareDependencies = {
  db: LevelDB;
  identityContext?: P2PIdentityContext;
  runtimeImport: RuntimeImport;
  getNode: () => any | null;
  connectPeer: (nodeInfo: PeerNodeInfo) => Promise<void>;
  broadcast: (topic: string, body: any) => Promise<void>;
  getTopicSubscribers: (topic: string) => string[];
  /** 成员节点地址声明处理（邀请码引导回填），由装配层注入 organization 服务 */
  onNodeInfoClaim?: (claim: unknown, context: { remotePeerId?: string }) => Promise<void>;
};

type OrgSyncState = {
  versions: OrganizationSyncVersions;
  lastSyncedAt: number;
};

/**
 * 组织成员同步服务（org-share）。
 *
 * 同时支持两条投递路径：
 * - 直连协议 `/spark/org-share/1.0.0`（优先）
 * - pubsub `spark-sync`（兜底重试）
 *
 * 发送侧成功判定统一为：收到匹配 syncId 的 ack。
 */
export class OrgShareSyncService {
  private readonly sessionState = new OrgShareSessionState();
  private readonly pullSync: OrgPullSyncService;

  constructor(private readonly deps: OrgShareDependencies) {
    this.pullSync = new OrgPullSyncService({
      db: this.deps.db,
      identityContext: this.deps.identityContext,
      runtimeImport: this.deps.runtimeImport,
      getNode: this.deps.getNode,
      connectPeer: this.deps.connectPeer,
      syncOrganizationToMember: async (nodeInfo, targetRootId, organization) =>
        this.syncOrganizationToMember(nodeInfo, targetRootId, organization),
      onNodeInfoClaim: this.deps.onNodeInfoClaim,
      onSyncState: async (peerId, orgId, versions) => this.saveOrgSyncState(peerId, orgId, versions)
    });
  }

  private orgSyncStateKey(peerId: string, orgId: string): string {
    return `p2p:org-sync-state:${peerId}:${orgId}`;
  }

  private async getOrgSyncState(peerId: string, orgId: string): Promise<OrgSyncState | null> {
    const raw = await this.deps.db.get(this.orgSyncStateKey(peerId, orgId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as OrgSyncState;
    } catch {
      return null;
    }
  }

  private async saveOrgSyncState(peerId: string, orgId: string, versions: OrganizationSyncVersions): Promise<void> {
    const state: OrgSyncState = {
      versions,
      lastSyncedAt: Date.now()
    };
    await this.deps.db.put(this.orgSyncStateKey(peerId, orgId), JSON.stringify(state));
  }

  markAck(syncId: string): void {
    this.sessionState.markAck(syncId);
  }

  async pullOrganizationsForCurrentRootFromPeer(
    nodeInfo: PeerNodeInfo,
    extras?: { nodeInfoClaim?: unknown }
  ): Promise<Awaited<ReturnType<OrgPullSyncService['reconcileFromPeer']>>> {
    return await this.pullSync.reconcileFromPeer(nodeInfo, extras);
  }

  /**
   * 组织副本概览（K 副本可见）：
   * 聚合本机 org 记录与逐成员 sync-state，给出"已有多少节点持有该组织副本"。
   * 计入副本的判定（本机恒算一个）：
   * - 最近窗口（ORG_REPLICA_FRESH_WINDOW_MS）内同步过；或
   * - sync-state 版本仍覆盖当前组织版本（静默组织的健康副本不会因 TTL 误判过期）。
   * 两者都不满足视为历史触达，不计入，由管理员补副本机制重新触达。
   */
  async getOrgSyncOverview(orgId: string): Promise<{
    orgId: string;
    replicaTarget: number;
    syncedPeers: number;
    totalMembers: number;
    members: Array<{
      rootId: string;
      peerId?: string;
      isSelf: boolean;
      everSynced: boolean;
      lastSyncedAt: number | null;
    }>;
  } | null> {
    const raw = await this.deps.db.get(`${ORG_META_PREFIX}${orgId}`);
    if (!raw) {
      return null;
    }

    let record: any;
    try {
      record = JSON.parse(raw);
    } catch {
      return null;
    }

    const currentRootId = await this.deps.identityContext?.getCurrentRootId();
    const currentVersions: OrganizationSyncVersions | undefined = record?.sync?.versions
      ?? (typeof record?.updatedAt === 'number' ? buildOrganizationSyncVersions(record) : undefined);
    const now = Date.now();
    const members = Array.isArray(record?.members) ? record.members : [];
    const overviewMembers: Array<{
      rootId: string;
      peerId?: string;
      isSelf: boolean;
      everSynced: boolean;
      lastSyncedAt: number | null;
    }> = [];
    let syncedPeers = 0;

    for (const member of members) {
      const rootId = typeof member?.rootId === 'string' ? member.rootId : '';
      if (!rootId) {
        continue;
      }
      const peerId = member?.nodeInfo?.peerId?.trim?.() || undefined;
      const isSelf = Boolean(currentRootId) && rootId === currentRootId;
      const state = peerId ? await this.getOrgSyncState(peerId, orgId) : null;
      const recentlySynced = Boolean(state) && now - state!.lastSyncedAt <= ORG_REPLICA_FRESH_WINDOW_MS;
      const coversCurrent = Boolean(state && currentVersions) && !isOrganizationSyncStale(state!.versions, currentVersions!);
      const everSynced = isSelf || recentlySynced || coversCurrent;
      if (everSynced) {
        syncedPeers += 1;
      }
      overviewMembers.push({
        rootId,
        peerId,
        isSelf,
        everSynced,
        lastSyncedAt: state?.lastSyncedAt ?? null
      });
    }

    return {
      orgId,
      replicaTarget: ORG_REPLICA_TARGET,
      syncedPeers,
      totalMembers: overviewMembers.length,
      members: overviewMembers
    };
  }

  async applyIncomingOrgShare(payload: any, source: 'pubsub' | 'direct'): Promise<{
    accepted: boolean;
    ackPayload?: {
      syncId?: string;
      orgId: string;
      targetRootId: string;
      receiverRootId: string;
    };
  }> {
    const targetRootId = payload?.targetRootId;
    const organization = payload?.organization;
    const syncId = payload?.syncId;
    if (!targetRootId || !organization?.orgId) {
      console.warn(`[p2p][org-share][${source}] invalid payload, skip`);
      return { accepted: false };
    }

    console.log(`[p2p][org-share][${source}] received candidate`, {
      orgId: organization.orgId,
      syncId,
      targetRootId,
      members: Array.isArray(organization.members) ? organization.members.length : 0
    });

    if (!this.deps.identityContext) {
      console.warn(`[p2p][org-share][${source}] missing identity context, skip`);
      return { accepted: false };
    }

    const currentRootId = await this.deps.identityContext.getCurrentRootId();
    if (!currentRootId || currentRootId !== targetRootId) {
      console.log(`[p2p][org-share][${source}] target mismatch, skip`, {
        currentRootId,
        targetRootId
      });
      return { accepted: false };
    }

    const members = Array.isArray(organization.members) ? organization.members : Array.isArray(organization.summary?.members) ? organization.summary.members : [];
    const containsCurrent = members.some((member: any) => member?.rootId === currentRootId);
    if (!containsCurrent) {
      console.warn(`[p2p][org-share][${source}] current root not found in members, skip`, {
        currentRootId,
        orgId: organization.orgId
      });
      return { accepted: false };
    }

    await this.deps.db.open();
    const existingRaw = await this.deps.db.get(`org:meta:${organization.orgId}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    const snapshot = normalizeIncomingSnapshot({ ...organization, members });
    const merged = mergeOrganizationSyncSnapshot(existing, snapshot);
    await this.deps.db.put(`org:meta:${organization.orgId}`, JSON.stringify(merged));
    const pluginDocs = Array.isArray(payload?.pluginDocs) ? payload.pluginDocs : [];
    const appliedPluginDocs = pluginDocs.length ? await applyPluginDocSyncItems(this.deps.db, pluginDocs) : 0;
    const persisted = await this.deps.db.get(`org:meta:${organization.orgId}`);
    console.log(`[p2p][org-share][${source}] organization synced from peer`, {
      orgId: organization.orgId,
      syncId,
      persisted: !!persisted,
      memberCount: merged.members.length,
      appliedPluginDocs
    });

    return {
      accepted: true,
      ackPayload: {
        syncId,
        orgId: organization.orgId,
        targetRootId,
        receiverRootId: currentRootId
      }
    };
  }

  async handleDirectIncoming(incoming: any): Promise<void> {
    const stream = resolveProtocolStream(incoming);
    if (!stream) {
      console.error('[p2p][org-share][direct] handler stream missing', {
        hasStream: !!incoming?.stream,
        hasIncomingStream: !!incoming?.incomingStream,
        hasDetailStream: !!incoming?.detail?.stream,
        hasDetailIncomingStream: !!incoming?.detail?.incomingStream,
        keys: incoming ? Object.keys(incoming) : []
      });
      return;
    }

    try {
      const requestText = await readStreamAsString(stream, 4000);
      const request = parseJsonSafely(requestText, 'direct request') as { type?: string; payload?: any } | null;
      if (!request) {
        await writeStringToStream(stream, JSON.stringify({ ok: false, reason: 'empty or invalid json' }));
        return;
      }

      console.log('[p2p][org-share][direct] request received', {
        type: request.type,
        syncId: request.payload?.syncId,
        orgId: request.payload?.organization?.orgId
      });

      if (request.type === 'org-pull-list' || request.type === 'org-pull-org') {
        const response = await this.pullSync.handleDirectRequest(request as any, incoming);
        await writeStringToStream(stream, JSON.stringify(response));
        return;
      }

      if (request.type !== 'org-share') {
        await writeStringToStream(stream, JSON.stringify({ ok: false, reason: 'invalid type' }));
        return;
      }

      const result = await this.applyIncomingOrgShare(request.payload, 'direct');
      if (!result.accepted || !result.ackPayload) {
        await writeStringToStream(stream, JSON.stringify({ ok: false, reason: 'not accepted' }));
        return;
      }

      await writeStringToStream(stream, JSON.stringify({
        ok: true,
        syncId: result.ackPayload.syncId,
        orgId: result.ackPayload.orgId,
        receiverRootId: result.ackPayload.receiverRootId
      }));

      console.log('[p2p][org-share][direct] ack responded', {
        syncId: result.ackPayload.syncId,
        orgId: result.ackPayload.orgId,
        receiverRootId: result.ackPayload.receiverRootId
      });
    } catch (error) {
      console.error('[p2p][org-share][direct] handler failed', error);
      try {
        await writeStringToStream(stream, JSON.stringify({ ok: false, reason: String(error) }));
      } catch {
        // ignore response write errors in handler failure path
      }
    }
  }

  async tryDirectOrgShare(nodeInfo: PeerNodeInfo, payload: { targetRootId: string; syncId: string; organization: any }): Promise<boolean> {
    const node = this.deps.getNode();
    if (!node) {
      return false;
    }

    const { multiaddr } = await this.deps.runtimeImport('@multiformats/multiaddr');
    const dialTargets = buildDialTargets(nodeInfo);
    for (const target of dialTargets) {
      try {
        console.log('[p2p][org-share][direct] dialing protocol', {
          target,
          protocol: DIRECT_ORG_SHARE_PROTOCOL,
          syncId: payload.syncId
        });

        const streamResult = await node.dialProtocol(multiaddr(target), DIRECT_ORG_SHARE_PROTOCOL);
        const stream = resolveProtocolStream(streamResult);
        if (!stream) {
          console.warn('[p2p][org-share][direct] dialProtocol returned unsupported stream shape', {
            target,
            hasStream: !!streamResult?.stream,
            hasIncomingStream: !!streamResult?.incomingStream,
            keys: streamResult ? Object.keys(streamResult) : []
          });
          continue;
        }

        await writeStringToStream(stream, JSON.stringify({ type: 'org-share', payload }));
        const responseText = await readStreamAsString(stream, 4000);
        const response = parseJsonSafely(responseText, 'direct response') as { ok?: boolean; syncId?: string; reason?: string } | null;
        if (!response) {
          console.warn('[p2p][org-share][direct] empty/invalid response', {
            target,
            syncId: payload.syncId
          });
          continue;
        }

        if (response.ok && response.syncId === payload.syncId) {
          console.log('[p2p][org-share][direct] delivery confirmed by direct response', {
            syncId: payload.syncId,
            orgId: payload.organization?.orgId,
            target
          });
          return true;
        }

        console.warn('[p2p][org-share][direct] response not accepted', {
          target,
          syncId: payload.syncId,
          response
        });
      } catch (error) {
        console.warn('[p2p][org-share][direct] dialProtocol failed', {
          target,
          error: String(error)
        });
      }
    }

    return false;
  }

  async syncOrganizationToMember(nodeInfo: PeerNodeInfo, targetRootId: string, organization: any): Promise<void> {
    const node = this.deps.getNode();
    if (!node) {
      throw new Error('p2p node not started');
    }

    const syncTopic = 'spark-sync';
    const syncId = crypto.randomBytes(12).toString('hex');
    const targetPeerId = extractPeerId(nodeInfo);
    const snapshot = organization.sync ? organization : buildOrganizationSyncSnapshot(organization);
    if (targetPeerId) {
      const previousState = await this.getOrgSyncState(targetPeerId, snapshot.orgId);
      if (previousState && !isOrganizationSyncStale(previousState.versions, snapshot.sync)) {
        console.log('[p2p][org-share] skip stale sync', {
          orgId: snapshot.orgId,
          targetPeerId,
          syncId
        });
        return;
      }
    }

    console.log('[p2p][org-share] start sync to member', {
      orgId: snapshot?.orgId,
      syncId,
      targetRootId,
      peerId: targetPeerId,
      addresses: nodeInfo.addresses
    });

    await this.deps.connectPeer(nodeInfo);
    await this.sessionState.waitForTopicSubscriber(syncTopic, targetPeerId, 5000, this.deps.getTopicSubscribers);

    console.log('[p2p][org-share] publishing with subscriber snapshot', {
      topic: syncTopic,
      targetPeerId,
      subscribers: this.deps.getTopicSubscribers(syncTopic)
    });

    const payload = {
      type: 'org-share',
      domain: 'system',
      payload: {
        targetRootId,
        syncId,
        organization: snapshot,
        pluginDocs: await collectSyncablePluginDocsByOrg(this.deps.db, snapshot.orgId),
        nodeInfo: { peerId: nodeInfo.peerId, addresses: nodeInfo.addresses }
      }
    } as const;

    const directDelivered = await this.tryDirectOrgShare(nodeInfo, payload.payload);
    if (directDelivered) {
      this.markAck(syncId);
      if (targetPeerId) {
        await this.saveOrgSyncState(targetPeerId, snapshot.orgId, snapshot.sync);
      }
      return;
    }

    const retryIntervalsMs = [0, 400, 1000, 2000, 3500];
    for (let i = 0; i < retryIntervalsMs.length; i += 1) {
      const waitMs = retryIntervalsMs[i];
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      await this.deps.broadcast(syncTopic, payload);
      console.log('[p2p][org-share] published', {
        orgId: organization?.orgId,
        syncId,
        targetRootId,
        attempt: i + 1,
        total: retryIntervalsMs.length,
        waitMs
      });

      const acked = await this.sessionState.waitAck(syncId, 1500);
      if (acked) {
        if (targetPeerId) {
          await this.saveOrgSyncState(targetPeerId, snapshot.orgId, snapshot.sync);
        }
        console.log('[p2p][org-share] delivery confirmed by ack', {
          syncId,
          orgId: snapshot?.orgId,
          targetRootId,
          attempt: i + 1
        });
        return;
      }

      console.warn('[p2p][org-share] ack timeout for attempt', {
        syncId,
        orgId: snapshot?.orgId,
        targetRootId,
        attempt: i + 1
      });
    }

    throw new Error(`Organization sync ack timeout: orgId=${snapshot?.orgId}, targetRootId=${targetRootId}, syncId=${syncId}`);
  }
}
