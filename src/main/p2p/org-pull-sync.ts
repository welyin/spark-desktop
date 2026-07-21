import { DIRECT_ORG_SHARE_PROTOCOL, ORG_META_PREFIX } from './constants';
import { buildDialTargets, extractPeerId } from './peer-targets';
import { buildOrganizationSyncSnapshot, isOrganizationSyncStale, mergeOrganizationSyncSnapshot, type OrganizationSyncVersions } from '../organization/sync';
import { normalizeIncomingSnapshot } from './org-share-snapshot';
import { applyPluginDocSyncItems, collectSyncablePluginDocsByOrg } from './plugin-org-sync';
import { parseJsonSafely, readStreamAsString, resolveProtocolStream, writeStringToStream } from './stream-utils';
import type { LevelDB } from '../db/base';
import type { P2PIdentityContext, PeerNodeInfo } from './types';
import type { OrganizationRecord } from '../organization';

type RuntimeImport = (specifier: string) => Promise<any>;

type OrgPullSyncDeps = {
  db: LevelDB;
  identityContext?: P2PIdentityContext;
  runtimeImport: RuntimeImport;
  getNode: () => any | null;
  connectPeer: (nodeInfo: PeerNodeInfo) => Promise<void>;
  syncOrganizationToMember?: (nodeInfo: PeerNodeInfo, targetRootId: string, organization: OrganizationRecord) => Promise<void>;
  /** 成员随 pull 请求捎带的节点地址声明（邀请码引导回填）；校验落库由上层完成 */
  onNodeInfoClaim?: (claim: unknown, context: { remotePeerId?: string }) => Promise<void>;
  /** 从某 peer 成功拉取组织后回调，用于累计该 peer 的副本同步状态 */
  onSyncState?: (peerId: string, orgId: string, versions: OrganizationSyncVersions) => Promise<void>;
};

type PullListRequest = {
  type: 'org-pull-list';
  payload: {
    requesterRootId: string;
    requesterPeerId?: string;
    nodeInfoClaim?: unknown;
  };
};

type PullOrgRequest = {
  type: 'org-pull-org';
  payload: {
    requesterRootId: string;
    requesterPeerId?: string;
    orgId: string;
  };
};

type PullRequest = PullListRequest | PullOrgRequest;

type PullListResponse = {
  ok: boolean;
  type: 'org-pull-list-response';
  organizations?: Array<{ orgId: string; sync?: OrganizationSyncVersions }>;
  reason?: string;
};

type PullOrgResponse = {
  ok: boolean;
  type: 'org-pull-org-response';
  orgId: string;
  status?: 'member' | 'removed';
  organization?: any;
  pluginDocs?: any[];
  reason?: string;
};

function parseOrganizationRecord(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractIncomingPeerId(incoming: any): string | null {
  const candidates = [
    incoming?.connection?.remotePeer,
    incoming?.detail?.connection?.remotePeer,
    incoming?.detail?.remotePeer,
    incoming?.remotePeer,
    incoming?.from
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate.toString === 'function') {
      const text = candidate.toString();
      if (typeof text === 'string' && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  return null;
}

function memberAuthStatus(record: any, requesterRootId: string, requesterPeerId?: string | null): { ok: boolean; reason?: string } {
  const members = Array.isArray(record?.members) ? record.members : [];
  const member = members.find((item: any) => item?.rootId === requesterRootId);
  if (!member) {
    return { ok: false, reason: 'not-member' };
  }

  const expectedPeerId = member?.nodeInfo?.peerId?.trim?.() || '';
  if (!expectedPeerId) {
    return { ok: true };
  }

  const actualPeerId = requesterPeerId?.trim() || '';
  if (!actualPeerId || actualPeerId !== expectedPeerId) {
    return { ok: false, reason: 'peer-mismatch' };
  }

  return { ok: true };
}

export class OrgPullSyncService {
  constructor(private readonly deps: OrgPullSyncDeps) {}

  private async listAllOrganizations(): Promise<any[]> {
    const rows = await this.deps.db.queryRange({
      prefix: ORG_META_PREFIX,
      start: ORG_META_PREFIX,
      end: `${ORG_META_PREFIX}\xFF`
    });

    return rows
      .map((row) => parseOrganizationRecord(row.value))
      .filter((record): record is any => record !== null);
  }

  private async listLocalRelatedOrganizations(currentRootId: string): Promise<Map<string, OrganizationRecord>> {
    const organizations = await this.listAllOrganizations();
    const related = organizations
      .filter((record) => Array.isArray(record.members) && record.members.some((member: any) => member?.rootId === currentRootId))
      .map((record) => record as OrganizationRecord);

    const byOrgId = new Map<string, OrganizationRecord>();
    for (const record of related) {
      if (record.orgId) {
        byOrgId.set(String(record.orgId), record);
      }
    }

    return byOrgId;
  }

  async handleDirectRequest(request: PullRequest, incoming: any): Promise<PullListResponse | PullOrgResponse> {
    const requesterRootId = request?.payload?.requesterRootId?.trim?.();
    if (!requesterRootId) {
      if (request.type === 'org-pull-org') {
        return { ok: false, type: 'org-pull-org-response', orgId: request.payload?.orgId || '', reason: 'missing-requester-root' };
      }
      return { ok: false, type: 'org-pull-list-response', reason: 'missing-requester-root' };
    }

    const remotePeerId = extractIncomingPeerId(incoming);
    const declaredPeerId = request.payload.requesterPeerId;
    const requesterPeerId = declaredPeerId || remotePeerId;

    if (request.type === 'org-pull-list') {
      let organizations = await this.listAllOrganizations();

      // 仅当请求方确实是某个组织的成员（按 rootId 判定，兼容 peerId 变更后的重认领）
      // 才处理其捎带的节点地址声明；否则未认证请求不得触发 claim 验签与落库扫描
      if (request.payload.nodeInfoClaim && this.deps.onNodeInfoClaim) {
        const isKnownMember = organizations.some((record) =>
          Array.isArray(record?.members) && record.members.some((member: any) => member?.rootId === requesterRootId)
        );
        if (isKnownMember) {
          try {
            await this.deps.onNodeInfoClaim(request.payload.nodeInfoClaim, { remotePeerId: remotePeerId ?? undefined });
            // claim 可能已回填成员地址并 bump 版本：必须重新读取，
            // 否则响应里的旧版本会让拉取方误判"本地更新"而把记录回推
            organizations = await this.listAllOrganizations();
          } catch (error) {
            console.warn('[p2p][org-pull] node info claim handling failed', {
              requesterRootId,
              error: String(error)
            });
          }
        }
      }

      const visible = organizations
        .filter((record) => memberAuthStatus(record, requesterRootId, requesterPeerId).ok)
        .map((record) => ({
          orgId: String(record.orgId),
          sync: record.sync?.versions
        }));

      return {
        ok: true,
        type: 'org-pull-list-response',
        organizations: visible
      };
    }

    const orgId = request.payload.orgId?.trim?.();
    if (!orgId) {
      return { ok: false, type: 'org-pull-org-response', orgId: '', reason: 'missing-org-id' };
    }

    const raw = await this.deps.db.get(`${ORG_META_PREFIX}${orgId}`);
    if (!raw) {
      return {
        ok: true,
        type: 'org-pull-org-response',
        orgId,
        status: 'removed',
        reason: 'org-not-found'
      };
    }

    const record = parseOrganizationRecord(raw);
    if (!record) {
      return { ok: false, type: 'org-pull-org-response', orgId, reason: 'invalid-org-record' };
    }

    const auth = memberAuthStatus(record, requesterRootId, requesterPeerId);
    if (!auth.ok) {
      return {
        ok: true,
        type: 'org-pull-org-response',
        orgId,
        status: 'removed',
        reason: auth.reason || 'not-member'
      };
    }

    const snapshot = normalizeIncomingSnapshot(record);
    return {
      ok: true,
      type: 'org-pull-org-response',
      orgId,
      status: 'member',
      organization: snapshot,
      pluginDocs: await collectSyncablePluginDocsByOrg(this.deps.db, orgId)
    };
  }

  private async requestDirect(nodeInfo: PeerNodeInfo, request: PullRequest): Promise<PullListResponse | PullOrgResponse | null> {
    const node = this.deps.getNode();
    if (!node) {
      throw new Error('p2p node not started');
    }

    const { multiaddr } = await this.deps.runtimeImport('@multiformats/multiaddr');
    const dialTargets = buildDialTargets(nodeInfo);

    for (const target of dialTargets) {
      try {
        const streamResult = await node.dialProtocol(multiaddr(target), DIRECT_ORG_SHARE_PROTOCOL);
        const stream = resolveProtocolStream(streamResult);
        if (!stream) {
          continue;
        }

        await writeStringToStream(stream, JSON.stringify(request));
        const responseText = await readStreamAsString(stream, 4000);
        const response = parseJsonSafely(responseText, 'pull response') as PullListResponse | PullOrgResponse | null;
        if (response) {
          return response;
        }
      } catch {
        // try next address
      }
    }

    return null;
  }

  private resolveLocalVersions(record: OrganizationRecord): OrganizationSyncVersions {
    return record.sync?.versions ?? buildOrganizationSyncSnapshot(record).sync;
  }

  /** 成功从某 peer 拉取组织后，把该 peer 的副本状态记账（失败仅记日志，不影响拉取结果） */
  private async recordPullSyncState(nodeInfo: PeerNodeInfo, orgId: string, record: OrganizationRecord): Promise<void> {
    if (!this.deps.onSyncState) {
      return;
    }
    const peerId = extractPeerId(nodeInfo);
    if (!peerId) {
      return;
    }
    try {
      await this.deps.onSyncState(peerId, orgId, this.resolveLocalVersions(record));
    } catch (error) {
      console.warn('[p2p][org-pull] sync state record failed', {
        orgId,
        peerId,
        error: String(error)
      });
    }
  }

  async reconcileFromPeer(nodeInfo: PeerNodeInfo, extras?: { nodeInfoClaim?: unknown }): Promise<{
    checked: number;
    synced: number;
    removed: number;
    pushAttempted: number;
    pushed: number;
    pulled: number;
    skipped: number;
  }> {
    const currentRootId = await this.deps.identityContext?.getCurrentRootId();
    if (!currentRootId) {
      return { checked: 0, synced: 0, removed: 0, pushAttempted: 0, pushed: 0, pulled: 0, skipped: 0 };
    }

    await this.deps.connectPeer(nodeInfo);

    const node = this.deps.getNode();
    const requesterPeerId = typeof node?.peerId?.toString === 'function' ? node.peerId.toString() : undefined;
    const listResponse = await this.requestDirect(nodeInfo, {
      type: 'org-pull-list',
      payload: { requesterRootId: currentRootId, requesterPeerId, nodeInfoClaim: extras?.nodeInfoClaim }
    });

    const remoteVersions = new Map<string, OrganizationSyncVersions | undefined>();
    if (listResponse?.type === 'org-pull-list-response' && listResponse.ok) {
      for (const item of listResponse.organizations ?? []) {
        remoteVersions.set(item.orgId, item.sync);
      }
    }

    const localOrganizations = await this.listLocalRelatedOrganizations(currentRootId);
    const targetOrgIds = Array.from(new Set([...localOrganizations.keys(), ...remoteVersions.keys()]));

    let pushed = 0;
    let pulled = 0;
    let pushAttempted = 0;
    let skipped = 0;
    let removed = 0;

    for (const orgId of targetOrgIds) {
      const local = localOrganizations.get(orgId);
      const remote = remoteVersions.get(orgId);

      if (local && !remote) {
        const response = await this.requestDirect(nodeInfo, {
          type: 'org-pull-org',
          payload: {
            requesterRootId: currentRootId,
            requesterPeerId,
            orgId
          }
        });

        if (response?.type === 'org-pull-org-response' && response.ok && response.status === 'removed') {
          await this.deps.db.del(`${ORG_META_PREFIX}${orgId}`);
          removed += 1;
          continue;
        }

        if (response?.type === 'org-pull-org-response' && response.ok && response.status === 'member' && response.organization) {
          const existing = parseOrganizationRecord(await this.deps.db.get(`${ORG_META_PREFIX}${orgId}`) ?? '') ?? null;
          const merged = mergeOrganizationSyncSnapshot(existing, normalizeIncomingSnapshot(response.organization));
          await this.deps.db.put(`${ORG_META_PREFIX}${orgId}`, JSON.stringify(merged));
          if (Array.isArray(response.pluginDocs) && response.pluginDocs.length > 0) {
            await applyPluginDocSyncItems(this.deps.db, response.pluginDocs);
          }
          pulled += 1;
          await this.recordPullSyncState(nodeInfo, orgId, merged);
          continue;
        }

        if (this.deps.syncOrganizationToMember) {
          pushAttempted += 1;
          try {
            await this.deps.syncOrganizationToMember(nodeInfo, currentRootId, local);
            pushed += 1;
          } catch (error) {
            console.warn('[p2p][org-pull] version-plan push failed', {
              orgId,
              peerId: nodeInfo.peerId,
              error: String(error)
            });
          }
        } else {
          skipped += 1;
        }
        continue;
      }

      if (local && remote) {
        const localVersions = this.resolveLocalVersions(local);
        const remoteNewer = isOrganizationSyncStale(localVersions, remote);
        const localNewer = isOrganizationSyncStale(remote, localVersions);

        if (localNewer && !remoteNewer) {
          if (this.deps.syncOrganizationToMember) {
            pushAttempted += 1;
            try {
              await this.deps.syncOrganizationToMember(nodeInfo, currentRootId, local);
              pushed += 1;
            } catch (error) {
              console.warn('[p2p][org-pull] version-plan push failed', {
                orgId,
                peerId: nodeInfo.peerId,
                error: String(error)
              });
            }
          } else {
            skipped += 1;
          }
          continue;
        }

        if (!localNewer && !remoteNewer) {
          skipped += 1;
          continue;
        }
      }

      const response = await this.requestDirect(nodeInfo, {
        type: 'org-pull-org',
        payload: {
          requesterRootId: currentRootId,
          requesterPeerId,
          orgId
        }
      });

      if (!response || response.type !== 'org-pull-org-response' || !response.ok) {
        continue;
      }

      if (response.status === 'removed') {
        const raw = await this.deps.db.get(`${ORG_META_PREFIX}${orgId}`);
        if (raw) {
          await this.deps.db.del(`${ORG_META_PREFIX}${orgId}`);
          removed += 1;
          console.log('[p2p][org-pull] removed stale local organization after peer reconciliation', {
            orgId,
            reason: response.reason || 'removed',
            peerId: nodeInfo.peerId,
            addresses: nodeInfo.addresses
          });
        }
        continue;
      }

      if (response.status === 'member' && response.organization) {
        const raw = await this.deps.db.get(`${ORG_META_PREFIX}${orgId}`);
        const existing = raw ? parseOrganizationRecord(raw) : null;
        const merged = mergeOrganizationSyncSnapshot(existing, normalizeIncomingSnapshot(response.organization));
        await this.deps.db.put(`${ORG_META_PREFIX}${orgId}`, JSON.stringify(merged));
        if (Array.isArray(response.pluginDocs) && response.pluginDocs.length > 0) {
          await applyPluginDocSyncItems(this.deps.db, response.pluginDocs);
        }
        pulled += 1;
        await this.recordPullSyncState(nodeInfo, orgId, merged);
      }
    }

    return {
      checked: targetOrgIds.length,
      synced: pulled,
      removed,
      pushAttempted,
      pushed,
      pulled,
      skipped
    };
  }
}
