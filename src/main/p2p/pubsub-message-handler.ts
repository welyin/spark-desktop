import type { LevelDB } from '../db/base';
import { getEvidenceHeadHash } from '../db/evidence';
import type { P2PMessageBody } from './types';
import type { OrgShareSyncService } from './org-share-sync';

declare const require: any;

/**
 * pubsub 入站处理依赖项。
 * 通过注入方式避免与 P2PNode 形成大块耦合，便于拆分与测试。
 */
type PubsubHandlerDeps = {
  db: LevelDB;
  verifySignature: (envelope: P2PMessageBody, pubKeyPem: string, signatureB64: string) => boolean;
  orgShare: OrgShareSyncService;
  broadcast: (topic: string, body: Omit<P2PMessageBody, 'timestamp' | 'pubKey' | 'signature' | 'version'> & { domain: string }) => Promise<void>;
};

/**
 * 创建统一的 pubsub 消息处理器。
 *
 * 支持消息类型：
 * - update/delete/history-response: 写入本地集合
 * - org-share: 校验后落库并回发 ack
 * - org-share-ack: 唤醒发送方等待器
 */
export function createPubsubMessageHandler(deps: PubsubHandlerDeps) {
  return async (raw: any) => {
    const msg = raw?.detail ?? raw;
    const dataBytes = msg?.data;
    const data = dataBytes ? Buffer.from(dataBytes).toString('utf8') : null;
    if (!data) return;

    try {
      const parsed: P2PMessageBody = JSON.parse(data);
      if (parsed.pubKey && parsed.signature) {
        const ok = deps.verifySignature(parsed, parsed.pubKey, parsed.signature);
        if (!ok) {
          console.warn('[p2p] signature invalid, drop message');
          return;
        }
      }

      if (parsed.type === 'update' || parsed.type === 'delete') {
        const domain = parsed.domain;
        const collection = parsed.collection;
        const id = parsed.id;
        const payload = parsed.payload ?? null;
        const meta = parsed.meta;
        if (!domain || !collection || !id || !meta) return;

        const { DocumentCollection } = require('../db/collection');
        const col = new DocumentCollection(deps.db, domain, collection, {});
        const { applyRemoteUpdate } = require('../db/sync');
        await applyRemoteUpdate(deps.db, col, domain, collection, id, payload, meta);

        if (parsed.evidenceHeadHash) {
          const localHeadHash = await getEvidenceHeadHash(deps.db);
          if (localHeadHash !== parsed.evidenceHeadHash) {
            console.warn('[p2p] evidence head mismatch, peer may have diverged');
          }
        }
      }

      if (parsed.type === 'history-response') {
        const domain = parsed.domain;
        const collection = parsed.collection;
        const id = parsed.id;
        const payload = parsed.payload ?? null;
        const meta = parsed.meta ?? null;
        if (!domain || !collection || !id || !meta) return;

        const { DocumentCollection } = require('../db/collection');
        const col = new DocumentCollection(deps.db, domain, collection, {});
        const { applyRemoteUpdate } = require('../db/sync');
        await applyRemoteUpdate(deps.db, col, domain, collection, id, payload, meta);
      }

      if (parsed.type === 'org-share') {
        const result = await deps.orgShare.applyIncomingOrgShare(parsed.payload, 'pubsub');
        if (result.accepted && result.ackPayload?.syncId) {
          await deps.broadcast('spark-sync', {
            type: 'org-share-ack',
            domain: 'system',
            payload: result.ackPayload
          });

          console.log('[p2p][org-share] ack sent', {
            syncId: result.ackPayload.syncId,
            orgId: result.ackPayload.orgId,
            receiverRootId: result.ackPayload.receiverRootId
          });
        }
      }

      if (parsed.type === 'org-share-ack') {
        const syncId = parsed.payload?.syncId;
        if (!syncId) {
          return;
        }

        deps.orgShare.markAck(syncId);
        console.log('[p2p][org-share] ack received', {
          syncId,
          orgId: parsed.payload?.orgId,
          receiverRootId: parsed.payload?.receiverRootId
        });
      }

      console.log('[p2p] received', parsed.type, 'domain=', parsed.domain);
    } catch (err) {
      console.error('[p2p] failed to handle message', err);
    }
  };
}
