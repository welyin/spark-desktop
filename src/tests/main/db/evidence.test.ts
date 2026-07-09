import { describe, expect, it } from 'vitest';
import { appendEvidence, verifyEvidenceChain, getEvidenceHeadHash, getEvidenceHeight, buildEvidencePayloadHash, buildEvidenceMetaHash } from '../../../main/db/evidence';

function createMockDB() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async batch(ops: Array<{ type: 'put' | 'del'; key: string; value?: string }>) {
      for (const op of ops) {
        if (op.type === 'put') {
          store.set(op.key, op.value ?? '');
        } else {
          store.delete(op.key);
        }
      }
    }
  } as any;
}

describe('evidence chain utilities', () => {
  it('builds stable payload and meta hashes', () => {
    const payload = { b: 2, a: 1 };
    const hash1 = buildEvidencePayloadHash(payload);
    const hash2 = buildEvidencePayloadHash({ a: 1, b: 2 });
    expect(hash1).toBe(hash2);
    const metaHash = buildEvidenceMetaHash({ createdAt: 1 });
    expect(typeof metaHash).toBe('string');
  });

  it('appends evidence entries and verifies the chain', async () => {
    const db = createMockDB();

    const entryA = await appendEvidence(db, {
      domain: 'plugin:test',
      collection: 'users',
      id: 'user-1',
      op: 'put',
      dataHash: 'datahash-a',
      payloadHash: 'payloadhash-a',
      metaHash: 'metahash-a',
      timestamp: 123,
      nodeId: 'node-a'
    });

    const entryB = await appendEvidence(db, {
      domain: 'plugin:test',
      collection: 'users',
      id: 'user-2',
      op: 'delete',
      dataHash: 'datahash-b',
      payloadHash: null,
      metaHash: 'metahash-b',
      timestamp: 456,
      nodeId: 'node-b'
    });

    expect(entryA.seq).toBe(1);
    expect(entryB.seq).toBe(2);
    expect(await getEvidenceHeadHash(db)).toBe(entryB.hash);
    expect(await getEvidenceHeight(db)).toBe(2);
    expect(await verifyEvidenceChain(db)).toBe(true);
  });
});
