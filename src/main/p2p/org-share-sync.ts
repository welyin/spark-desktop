import crypto from 'crypto';
import type { LevelDB } from '../db/base';
import { DIRECT_ORG_SHARE_PROTOCOL } from './constants';
import { buildDialTargets, extractPeerId } from './peer-targets';
import { buildOrganizationSyncSnapshot, isOrganizationSyncStale, mergeOrganizationSyncSnapshot, type OrganizationSyncSnapshot, type OrganizationSyncVersions } from '../organization/sync';
import { OrgShareSessionState } from './org-share-session';
import { OrgPullSyncService } from './org-pull-sync';
import { normalizeIncomingSnapshot } from './org-share-snapshot';
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
      connectPeer: this.deps.connectPeer
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

  async pullOrganizationsForCurrentRootFromPeer(nodeInfo: PeerNodeInfo): Promise<{ checked: number; synced: number; removed: number }> {
    return await this.pullSync.reconcileFromPeer(nodeInfo);
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
    const snapshot = normalizeIncomingSnapshot({
      ...organization,
      members
    });
    const merged = mergeOrganizationSyncSnapshot(existing, snapshot);
    await this.deps.db.put(`org:meta:${organization.orgId}`, JSON.stringify(merged));
    const persisted = await this.deps.db.get(`org:meta:${organization.orgId}`);
    console.log(`[p2p][org-share][${source}] organization synced from peer`, {
      orgId: organization.orgId,
      syncId,
      persisted: !!persisted,
      memberCount: merged.members.length
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
        nodeInfo: {
          peerId: nodeInfo.peerId,
          addresses: nodeInfo.addresses
        }
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
