/**
 * org 模块 golden vector 提取脚本（Rust 内核重写阶段，一次性运行）。
 *
 * 从 TS 实现反向提取验收向量，写入 code/spec/vectors/org.json，覆盖：
 *   - nodeInfoClaim：真实 RootIdentityManager recover 中文 mnemonic →
 *     signWithRootIdentity 签名固定载荷（含 peerId / 缺 peerId 两例），
 *     并由真实 verifyNodeInfoClaim 交叉验证（ok 与负例 reason）
 *   - 邀请码：真实 encodeOrgInvite/decodeOrgInvite（Date.now 打桩保证确定性），
 *     含过期报错与"未来 createdAt 无上限"口径
 *   - recovery token：真实 computeRecoveryToken / activeRecoveryTokens
 *   - 同步：真实 buildOrganizationSyncSnapshot / mergeOrganizationSyncSnapshot /
 *     isOrganizationSyncStale
 *
 * 运行方式（在 desktop/ 目录下）：
 *   esbuild scripts/extract-org-vectors.mts --bundle --platform=node --format=esm \
 *     --packages=external --alias:electron=./scripts/electron-stub.mjs \
 *     --outfile=node_modules/.cache/extract-org-vectors.mjs && node node_modules/.cache/extract-org-vectors.mjs
 *
 * 确定性：所有随机值（mnemonic / 时间戳 / orgId / recoverySecret）均为硬编码常量；
 * Date.now 在解码/合并调用期间被打桩为固定值，重复运行产出字节级一致的 JSON。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { RootIdentityManager } from '../src/main/identity/root-id.js';
import { buildNodeInfoClaimPayload, verifyNodeInfoClaim } from '../src/main/organization/node-info-claim.js';
import { decodeOrgInvite, encodeOrgInvite } from '../src/main/organization/invite.js';
import {
  buildOrganizationSyncSnapshot,
  buildOrganizationSyncVersions,
  isOrganizationSyncStale,
  mergeOrganizationSyncSnapshot
} from '../src/main/organization/sync.js';
import { activeRecoveryTokens, computeRecoveryToken } from '../src/main/p2p/org-recovery.js';

const MNEMONIC_ZH = '与 祝 产 鸡 永 烂 施 师 蓝 荷 有 邓 朗 防 管 李 原 芳 饿 万 措 走 腰 旅';
const V2_PASSWORD = 'Vectors#2024';
const NOW = 1720000000000;
const CLAIM_TIMESTAMP = 1720000000000;
const ORG_ID = 'org_0123456789abcdef';
const RECOVERY_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2';
const ROOT_A = 'aa'.repeat(32);
const ROOT_B = 'bb'.repeat(32);
const ROOT_C = 'cc'.repeat(32);

function rid64(ch: string): string {
  return ch.repeat(64);
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'spark-org-vectors-'));
  try {
    // --- 0. 真实 recover 中文 mnemonic → root 身份（claim 签名密钥） ---
    const manager = new RootIdentityManager(dir);
    const { rootId } = await manager.recoverFromMnemonic(MNEMONIC_ZH, V2_PASSWORD, '向量用户');

    // --- 1. nodeInfoClaim：真实 buildNodeInfoClaimPayload + signWithRootIdentity + verify ---
    const claimCases: unknown[] = [];
    for (const withPeerId of [true, false]) {
      const nodeInfo = {
        peerId: withPeerId ? '12D3KooWVectorPeerId' : undefined,
        addresses: ['/ip4/192.168.1.10/tcp/15002/ws', '/dns4/node.example.com/tcp/15002/ws']
      };
      const unsigned = {
        type: 'spark-node-info-claim' as const,
        version: 1 as const,
        rootId,
        publicKey: '',
        nodeInfo,
        timestamp: CLAIM_TIMESTAMP
      };
      const payload = buildNodeInfoClaimPayload(unsigned);
      // 真实签名（publicKey 一并来自 manager，保证 sha256(publicKey)===rootId）
      const signed = manager.signWithRootIdentity(payload);
      unsigned.publicKey = signed.publicKey;
      const claim = { ...unsigned, signature: signed.signature };
      // 载荷必须与最终 publicKey 一致后重算（publicKey 在载荷内）
      const finalPayload = buildNodeInfoClaimPayload(claim);
      const resigned = manager.signWithRootIdentity(finalPayload);
      claim.signature = resigned.signature;

      const verifyOk = verifyNodeInfoClaim(claim, { nowMs: NOW });
      const verifyTampered = verifyNodeInfoClaim({ ...claim, timestamp: CLAIM_TIMESTAMP + 1 }, { nowMs: NOW });
      const verifyStale = verifyNodeInfoClaim(claim, { nowMs: NOW + 10 * 60 * 1000 + 1 });
      if (!verifyOk.ok) {
        throw new Error('claim cross-check failed');
      }
      claimCases.push({
        name: withPeerId ? 'with-peer-id' : 'without-peer-id',
        claim,
        payload: finalPayload,
        verify: verifyOk,
        verifyTampered,
        verifyStale
      });
    }

    // --- 2. 邀请码：真实 encode/decode（Date.now 打桩） ---
    const realDateNow = Date.now;
    Date.now = () => NOW;
    let inviteCases: unknown[] = [];
    let inviteErrors: unknown[] = [];
    try {
      for (const withPeerId of [true, false]) {
        const payload = {
          type: 'spark-org-invite' as const,
          version: 1 as const,
          orgId: ORG_ID,
          orgName: '星火 组织',
          inviter: {
            rootId: rootId,
            peerId: withPeerId ? '12D3KooWInviterPeer' : undefined,
            addresses: ['/ip4/10.0.0.8/tcp/15002/ws']
          },
          createdAt: NOW - 60 * 60 * 1000
        };
        const code = encodeOrgInvite(payload);
        const decoded = decodeOrgInvite(code);
        inviteCases.push({ name: withPeerId ? 'with-peer-id' : 'without-peer-id', payload, code, decoded });
      }
      // 归一化：rootId 大写 + orgId 带空白 + addresses 混入非字符串/空串
      const messyPayload = {
        type: 'spark-org-invite',
        version: 1,
        orgId: `  ${ORG_ID}  `,
        inviter: { rootId: ` ${rootId.toUpperCase()} `, addresses: [' /ip4/10.0.0.8/tcp/15002/ws ', 42, ''] },
        createdAt: NOW - 1000
      } as never;
      const messyCode = encodeOrgInvite(messyPayload);
      inviteCases.push({ name: 'normalized-messy-fields', code: messyCode, decoded: decodeOrgInvite(messyCode) });

      // 恰好 24h 边界：仍有效（`>` 才过期）
      const boundary = encodeOrgInvite({
        type: 'spark-org-invite', version: 1, orgId: ORG_ID, orgName: '',
        inviter: { rootId, peerId: '12D3KooWInviterPeer', addresses: [] },
        createdAt: NOW - 24 * 60 * 60 * 1000
      });
      inviteCases.push({ name: 'freshness-boundary-24h', code: boundary, decoded: decodeOrgInvite(boundary) });

      // 未来 createdAt：不设上限（spec §2.3 如实复刻）
      const future = encodeOrgInvite({
        type: 'spark-org-invite', version: 1, orgId: ORG_ID, orgName: '',
        inviter: { rootId, peerId: '12D3KooWInviterPeer', addresses: [] },
        createdAt: NOW + 10 * 365 * 24 * 60 * 60 * 1000
      });
      inviteCases.push({ name: 'future-created-at-accepted', code: future, decoded: decodeOrgInvite(future) });

      // 过期：24h + 1ms
      const expired = encodeOrgInvite({
        type: 'spark-org-invite', version: 1, orgId: ORG_ID, orgName: '',
        inviter: { rootId, peerId: '12D3KooWInviterPeer', addresses: [] },
        createdAt: NOW - 24 * 60 * 60 * 1000 - 1
      });
      for (const [name, text] of [
        ['expired', expired],
        ['empty', ''],
        ['malformed', '!!!not-base64!!!'],
        ['wrong-type', encodeOrgInvite({ type: 'other' } as never)]
      ] as const) {
        try {
          decodeOrgInvite(text);
          inviteErrors.push({ name, error: null });
        } catch (error) {
          inviteErrors.push({ name, error: (error as Error).message });
        }
      }
    } finally {
      Date.now = realDateNow;
    }

    // --- 3. recovery token（真实 computeRecoveryToken/activeRecoveryTokens） ---
    const bucket = Math.floor(NOW / 600000);
    const recovery = {
      orgId: ORG_ID,
      recoverySecret: RECOVERY_SECRET,
      nowMs: NOW,
      timeBucket: bucket,
      token: computeRecoveryToken(ORG_ID, RECOVERY_SECRET, bucket),
      activeTokens: activeRecoveryTokens(ORG_ID, RECOVERY_SECRET, NOW)
    };

    // --- 4. 同步：versions / stale / buildSnapshot / merge（真实实现） ---
    const versionsOf = (v: number, tx?: number) => ({
      summaryVersion: v,
      membersVersion: v,
      memberDetailsVersion: v,
      transactionsVersion: tx ?? v
    });
    const staleCases = [
      { name: 'local-missing', local: undefined, incoming: versionsOf(100) },
      { name: 'equal', local: versionsOf(100), incoming: versionsOf(100) },
      { name: 'incoming-newer-one-field', local: versionsOf(100), incoming: versionsOf(100, 101) },
      { name: 'incoming-older', local: versionsOf(200), incoming: versionsOf(100) },
      {
        name: 'fork-a',
        local: { ...versionsOf(100), summaryVersion: 200 },
        incoming: { ...versionsOf(100), membersVersion: 200 }
      },
      {
        name: 'fork-b',
        local: { ...versionsOf(100), membersVersion: 200 },
        incoming: { ...versionsOf(100), summaryVersion: 200 }
      }
    ].map((c) => ({ ...c, expected: isOrganizationSyncStale(c.local as never, c.incoming as never) }));

    // buildSnapshot：record 带 recoverySecret（经 metadata 流动）+ 一条事务（transactionsVersion 独立）
    const baseRecord = {
      orgId: ORG_ID,
      name: '星火组织',
      description: 'desc',
      basePluginDomain: 'plugin:chat',
      createdAt: 1699990000000,
      createdBy: ROOT_A,
      updatedAt: 1700000001000,
      recoverySecret: RECOVERY_SECRET,
      customKey: 'old',
      members: [
        { rootId: ROOT_A, role: 'admin' as const, joinedAt: 1699990000000, addedBy: ROOT_A },
        {
          rootId: ROOT_B,
          role: 'member' as const,
          joinedAt: 1699995000000,
          addedBy: ROOT_A,
          nodeInfo: { peerId: '12D3KooWMemberB', addresses: ['/ip4/9.9.9.9/tcp/15002/ws'] }
        }
      ],
      sync: {
        versions: versionsOf(1700000001000, 1700000000500),
        sections: ['transactions', 'summary', 'members', 'member-details'],
        lastSyncedAt: 0
      }
    };
    const snapshotTx = {
      txId: '0123456789abcdef',
      orgId: ORG_ID,
      type: 'member-add' as const,
      createdAt: 1700000000800,
      actorRootId: ROOT_A,
      targetRootId: ROOT_B,
      summary: `添加成员 ${ROOT_B}`
    };
    const builtSnapshot = buildOrganizationSyncSnapshot(baseRecord as never, [snapshotTx as never]);

    // merge：existing 与 incoming 有成员覆盖/新增、nodeInfo 回退、metadata 合并、updatedAt max
    const incomingRecord = {
      ...baseRecord,
      name: '星火组织（新名）',
      updatedAt: 1700000002000,
      customKey: 'new',
      anotherKey: 42,
      members: [
        { rootId: ROOT_A, role: 'member' as const, joinedAt: 1699990000000, addedBy: ROOT_C },
        { rootId: ROOT_B, role: 'member' as const, joinedAt: 1699995000000, addedBy: ROOT_A },
        { rootId: ROOT_C, role: 'member' as const, joinedAt: 1700000001500, addedBy: ROOT_A }
      ]
    };
    delete (incomingRecord as Record<string, unknown>).sync;
    Date.now = () => NOW;
    let merged: unknown;
    try {
      const incomingSnapshot = buildOrganizationSyncSnapshot(incomingRecord as never, []);
      merged = mergeOrganizationSyncSnapshot(baseRecord as never, incomingSnapshot);
    } finally {
      Date.now = realDateNow;
    }

    const vectors = {
      meta: {
        title: 'org golden vectors（org.md / p2p-messages.md §8.1）',
        generatedBy: 'desktop/scripts/extract-org-vectors.mts（一次性运行，见脚本头注释）',
        source: 'desktop/src/main/organization/{invite,node-info-claim,sync}.ts, p2p/org-recovery.ts, identity/root-id.ts',
        deterministic: '所有随机值与时间戳硬编码；Date.now 在解码/合并期间打桩为 NOW=1720000000000',
        crossChecks: [
          'nodeInfoClaim：真实 RootIdentityManager.recover 中文 mnemonic → signWithRootIdentity 签名 → 真实 verifyNodeInfoClaim 判定 ok（负例 reason 一并记录）',
          '邀请码：真实 encodeOrgInvite/decodeOrgInvite 往返；过期/格式错误消息来自真实抛错',
          'recovery token / stale / buildSnapshot / merge：全部直接调用真实导出函数'
        ]
      },
      constants: {
        nowMs: NOW,
        orgInviteMaxAgeMs: 24 * 60 * 60 * 1000,
        nodeInfoClaimMaxAgeMs: 10 * 60 * 1000,
        recoveryTimeBucketMs: 600000,
        orgReplicaTarget: 3,
        orgReplicaFreshWindowMs: 30 * 24 * 60 * 60 * 1000
      },
      nodeInfoClaim: {
        mnemonic: MNEMONIC_ZH,
        rootId,
        cases: claimCases
      },
      invite: {
        cases: inviteCases,
        errors: inviteErrors
      },
      recoveryToken: recovery,
      sync: {
        staleCases,
        buildSnapshot: { record: baseRecord, transactions: [snapshotTx], expected: builtSnapshot },
        merge: { existing: baseRecord, incoming: incomingRecord, expected: merged },
        versionsFromRecord: buildOrganizationSyncVersions(baseRecord as never, 1700000000800)
      }
    };

    // 注意：脚本经 esbuild 打包到 node_modules/.cache 下运行，import.meta.url 不可靠；
    // 以 process.cwd()（desktop/）为基准定位输出目录。
    const outPath = path.resolve(process.cwd(), '../code/spec/vectors/org.json');
    writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n', 'utf8');
    console.log(`org vectors written: ${outPath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
