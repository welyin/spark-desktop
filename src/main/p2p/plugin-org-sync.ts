import { DocumentCollection } from '../db/collection';
import type { LevelDB } from '../db/base';
import { applyRemoteUpdate, getMeta } from '../db/sync';

type PluginDocSyncItem = {
  domain: string;
  collection: string;
  id: string;
  payload: Record<string, unknown>;
  meta: { vv: Record<string, number>; ts: number; nodeId?: string };
};

const PLUGIN_DOC_PREFIX = 'doc:plugin:';

function parsePluginDocKey(key: string): { domain: string; collection: string; id: string } | null {
  const match = key.match(/^doc:(plugin:[^:]+):([^:]+):(.+)$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  return {
    domain: match[1],
    collection: match[2],
    id: match[3]
  };
}

function isSyncDisabled(payload: Record<string, unknown>): boolean {
  const marker = payload.__sync;
  if (marker === false) {
    return true;
  }

  if (!marker || typeof marker !== 'object') {
    return false;
  }

  const sync = marker as Record<string, unknown>;
  if (sync.disabled === true) {
    return true;
  }

  const mode = String(sync.mode ?? sync.strategy ?? '').trim().toLowerCase();
  return mode === 'local' || mode === 'none' || mode === 'disabled';
}

function resolveOrgId(payload: Record<string, unknown>): string {
  const value = payload.orgId;
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

export async function collectSyncablePluginDocsByOrg(db: LevelDB, orgId: string): Promise<PluginDocSyncItem[]> {
  const targetOrgId = String(orgId || '').trim();
  if (!targetOrgId) {
    return [];
  }

  const rows = await db.queryRange({
    prefix: PLUGIN_DOC_PREFIX,
    start: PLUGIN_DOC_PREFIX,
    end: `${PLUGIN_DOC_PREFIX}\xFF`
  });

  const results: PluginDocSyncItem[] = [];

  for (const row of rows) {
    const keyInfo = parsePluginDocKey(row.key);
    if (!keyInfo) {
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (resolveOrgId(payload) !== targetOrgId) {
      continue;
    }

    if (isSyncDisabled(payload)) {
      continue;
    }

    const meta = await getMeta(db, keyInfo.domain, keyInfo.collection, keyInfo.id);
    if (!meta || typeof meta !== 'object' || !meta.vv || typeof meta.ts !== 'number') {
      continue;
    }

    results.push({
      domain: keyInfo.domain,
      collection: keyInfo.collection,
      id: keyInfo.id,
      payload,
      meta: {
        vv: meta.vv,
        ts: meta.ts,
        nodeId: typeof meta.nodeId === 'string' ? meta.nodeId : undefined
      }
    });
  }

  return results;
}

export async function applyPluginDocSyncItems(db: LevelDB, items: PluginDocSyncItem[]): Promise<number> {
  let applied = 0;

  for (const item of items) {
    const coll = new DocumentCollection(db, item.domain, item.collection, {
      enableEvidence: true,
      indexedFields: []
    });

    await applyRemoteUpdate(
      db,
      coll,
      item.domain,
      item.collection,
      item.id,
      item.payload,
      item.meta
    );

    applied += 1;
  }

  return applied;
}
