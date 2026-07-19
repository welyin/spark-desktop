import crypto from 'crypto';
import { LevelDBOperation, LevelDB } from './base';

export interface EvidenceEntry {
  seq: number;
  prevHash: string | null;
  domain: string;
  collection: string;
  id: string;
  op: 'put' | 'delete';
  dataHash: string;
  payloadHash: string | null;
  metaHash: string | null;
  hash: string;
  timestamp: number;
  nodeId: string;
}

const EVIDENCE_PREFIX = 'doc:evidence:proof:';
const EVIDENCE_HEAD_KEY = 'doc:evidence:head';

function normalizeObject(value: any) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  const ordered: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = normalizeObject((value as Record<string, any>)[key]);
  }
  return JSON.stringify(ordered);
}

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function buildEvidencePayloadHash(payload: any) {
  if (payload === null || payload === undefined) return null;
  return sha256(normalizeObject(payload));
}

export function buildEvidenceMetaHash(meta: any) {
  if (meta === null || meta === undefined) return null;
  return sha256(normalizeObject(meta));
}

export function buildEvidenceDataHash(
  domain: string,
  collection: string,
  id: string,
  op: 'put' | 'delete',
  payloadHash: string | null,
  metaHash: string | null
) {
  return sha256(normalizeObject({ domain, collection, id, op, payloadHash, metaHash }));
}

export function buildEvidenceEntryHash(entry: Omit<EvidenceEntry, 'hash'>) {
  const payload = {
    seq: entry.seq,
    prevHash: entry.prevHash,
    domain: entry.domain,
    collection: entry.collection,
    id: entry.id,
    op: entry.op,
    dataHash: entry.dataHash,
    payloadHash: entry.payloadHash,
    metaHash: entry.metaHash,
    timestamp: entry.timestamp,
    nodeId: entry.nodeId
  };
  return sha256(normalizeObject(payload));
}

export function evidenceKey(seq: number) {
  return `${EVIDENCE_PREFIX}${String(seq).padStart(12, '0')}`;
}

export async function getEvidenceHead(db: LevelDB): Promise<{ seq: number; hash: string } | null> {
  const raw = await db.get(EVIDENCE_HEAD_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as { seq: number; hash: string };
  } catch (err) {
    return null;
  }
}

export async function buildNextEvidenceEntry(
  db: LevelDB,
  entry: Omit<EvidenceEntry, 'seq' | 'hash' | 'prevHash'>
): Promise<EvidenceEntry> {
  const head = await getEvidenceHead(db);
  const seq = head ? head.seq + 1 : 1;
  const prevHash = head ? head.hash : null;
  const newEntry: EvidenceEntry = {
    ...entry,
    seq,
    prevHash,
    hash: ''
  };
  newEntry.hash = buildEvidenceEntryHash(newEntry);
  return newEntry;
}

export function evidenceBatchOperations(entry: EvidenceEntry): LevelDBOperation[] {
  return [
    { type: 'put', key: evidenceKey(entry.seq), value: JSON.stringify(entry) },
    { type: 'put', key: EVIDENCE_HEAD_KEY, value: JSON.stringify({ seq: entry.seq, hash: entry.hash }) }
  ];
}

export async function appendEvidence(db: LevelDB, entry: Omit<EvidenceEntry, 'seq' | 'hash' | 'prevHash'>): Promise<EvidenceEntry> {
  const newEntry = await buildNextEvidenceEntry(db, entry);
  const ops: LevelDBOperation[] = evidenceBatchOperations(newEntry);
  await db.batch(ops);
  return newEntry;
}

export async function getEvidenceEntry(db: LevelDB, seq: number): Promise<EvidenceEntry | null> {
  const raw = await db.get(evidenceKey(seq));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as EvidenceEntry;
  } catch (err) {
    return null;
  }
}

export async function verifyEvidenceChain(db: LevelDB): Promise<boolean> {
  const head = await getEvidenceHead(db);
  if (!head) return true;
  let prevHash: string | null = null;
  for (let seq = 1; seq <= head.seq; seq += 1) {
    const entry = await getEvidenceEntry(db, seq);
    if (!entry) return false;
    if (entry.prevHash !== prevHash) return false;
    const expectedHash = buildEvidenceEntryHash({
      seq: entry.seq,
      prevHash: entry.prevHash,
      domain: entry.domain,
      collection: entry.collection,
      id: entry.id,
      op: entry.op,
      dataHash: entry.dataHash,
      payloadHash: entry.payloadHash,
      metaHash: entry.metaHash,
      timestamp: entry.timestamp,
      nodeId: entry.nodeId
    });
    if (entry.hash !== expectedHash) return false;
    prevHash = entry.hash;
  }
  return true;
}

export async function getEvidenceHeadHash(db: LevelDB): Promise<string | null> {
  const head = await getEvidenceHead(db);
  return head ? head.hash : null;
}

export async function getEvidenceHeight(db: LevelDB): Promise<number> {
  const head = await getEvidenceHead(db);
  return head ? head.seq : 0;
}

export async function verifyEvidenceHashMatchesRemote(db: LevelDB, remoteHash: string): Promise<boolean> {
  const localHash = await getEvidenceHeadHash(db);
  return localHash === remoteHash;
}
