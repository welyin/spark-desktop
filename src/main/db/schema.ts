import { LevelDB } from './base';

/**
 * 集合同步策略声明与注册表
 *
 * 设计文档 V2 §4.3.4：每个集合创建时必须显式声明冲突处理策略，
 * SDK 在类型层面强制；底层默认给最安全的原语。
 *
 * - `append-only`（默认）：仅追加、不覆盖、不删除，天然无写冲突，自动配合链式存证。
 *   治理类数据（投票、成员、账目）由系统强制使用该策略，插件无权降级。
 * - `lww`（显式声明）：最后写入获胜，仅适用于可容忍覆盖的普通状态数据（草稿、偏好等）。
 *
 * 声明持久化在系统域（插件无法通过底层 db 接口篡改），一旦声明不可变更。
 * 同步消息携带的策略声明副本仅作为接收方本次应用的瞬时兜底（见 db/sync.ts），
 * 永不写入本注册表——集合策略只接受本地声明，网络来源无法锁死或降级本地策略。
 */

export type SyncStrategy = 'append-only' | 'lww';

/** 集合同步策略声明（SDK 层 syncStrategy 必填，类型层面强制显式选择） */
export interface CollectionSchemaDeclaration {
  syncStrategy: SyncStrategy;
  /** 治理类数据（投票、成员、账目）标记：强制 append-only + 链式存证 */
  governance?: boolean;
  /** 链式存证开关；append-only / 治理类集合强制开启，lww 集合可显式开启 */
  enableEvidence?: boolean;
}

/** 归一化后的集合策略 */
export interface ResolvedCollectionPolicy {
  syncStrategy: SyncStrategy;
  governance: boolean;
  enableEvidence: boolean;
}

/** 持久化的集合策略记录 */
export interface CollectionSchemaRecord extends ResolvedCollectionPolicy {
  domain: string;
  collection: string;
  declaredAt: number;
}

/** 未声明集合的兜底策略：最安全的 append-only + 存证 */
export const DEFAULT_COLLECTION_POLICY: ResolvedCollectionPolicy = {
  syncStrategy: 'append-only',
  governance: false,
  enableEvidence: true
};

const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 策略记录的存储键。
 * id 部分整体 encodeURIComponent，保证键仍符合 doc:{domain}:{collection}:{id} 三段式，
 * 且 parseDomainFromKey 解析结果为系统域（插件经底层 db 接口无法读写）。
 */
export function collectionSchemaKey(domain: string, collection: string): string {
  return `doc:system:collection-schema:${encodeURIComponent(`${domain}/${collection}`)}`;
}

export function isSyncStrategy(value: unknown): value is SyncStrategy {
  return value === 'append-only' || value === 'lww';
}

/**
 * 归一化声明并应用强制规则：
 * - 治理类数据声明非 append-only 视为降级尝试，直接拒绝
 * - 治理类 / append-only 集合强制开启链式存证
 */
export function resolveSchemaDeclaration(declaration: CollectionSchemaDeclaration): ResolvedCollectionPolicy {
  if (!declaration || !isSyncStrategy(declaration.syncStrategy)) {
    throw new Error('Invalid collection schema: syncStrategy must be declared as "append-only" or "lww"');
  }
  const governance = declaration.governance === true;
  if (governance && declaration.syncStrategy !== 'append-only') {
    throw new Error(
      'Governance collections (votes, members, accounts) must use the append-only sync strategy; downgrade is not allowed'
    );
  }
  const syncStrategy = declaration.syncStrategy;
  const enableEvidence = syncStrategy === 'append-only' ? true : declaration.enableEvidence === true;
  return { syncStrategy, governance, enableEvidence };
}

/** 读取已声明的集合策略；未声明或记录损坏时返回 null */
export async function getCollectionSchema(
  db: LevelDB,
  domain: string,
  collection: string
): Promise<CollectionSchemaRecord | null> {
  const raw = await db.get(collectionSchemaKey(domain, collection));
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CollectionSchemaRecord>;
    if (!isSyncStrategy(parsed?.syncStrategy)) {
      return null;
    }
    return {
      domain,
      collection,
      syncStrategy: parsed.syncStrategy,
      governance: parsed.governance === true,
      enableEvidence: parsed.enableEvidence === true,
      declaredAt: typeof parsed.declaredAt === 'number' ? parsed.declaredAt : 0
    };
  } catch {
    return null;
  }
}

function samePolicy(a: ResolvedCollectionPolicy, b: ResolvedCollectionPolicy): boolean {
  return a.syncStrategy === b.syncStrategy && a.governance === b.governance && a.enableEvidence === b.enableEvidence;
}

/**
 * 声明集合同步策略（幂等）：
 * - 首次声明持久化到系统域
 * - 重复声明与既有记录一致则直接返回；冲突声明抛错（插件 bug 或版本不一致）
 * - 仅供本地调用（插件经 IPC 声明）；网络来源的声明副本永不允许写入（见 db/sync.ts）
 */
export async function declareCollectionSchema(
  db: LevelDB,
  domain: string,
  collection: string,
  declaration: CollectionSchemaDeclaration
): Promise<CollectionSchemaRecord> {
  if (!COLLECTION_NAME_PATTERN.test(collection)) {
    throw new Error(`Invalid collection name "${collection}": only letters, digits, "_" and "-" are allowed`);
  }
  const policy = resolveSchemaDeclaration(declaration);
  const existing = await getCollectionSchema(db, domain, collection);

  if (existing) {
    const existingPolicy: ResolvedCollectionPolicy = {
      syncStrategy: existing.syncStrategy,
      governance: existing.governance,
      enableEvidence: existing.enableEvidence
    };
    if (samePolicy(existingPolicy, policy)) {
      return existing;
    }
    throw new Error(
      `Collection "${collection}" in ${domain} is already declared with syncStrategy "${existing.syncStrategy}" ` +
        `(governance=${existing.governance}, enableEvidence=${existing.enableEvidence}) and cannot be re-declared`
    );
  }

  const record: CollectionSchemaRecord = {
    ...policy,
    domain,
    collection,
    declaredAt: Date.now()
  };
  await db.put(collectionSchemaKey(domain, collection), JSON.stringify(record));
  return record;
}

/**
 * 解析集合当前生效策略：持久化声明优先；其次调用方兜底声明；最后退回默认（最安全）
 */
export async function resolveCollectionPolicy(
  db: LevelDB,
  domain: string,
  collection: string,
  fallbackDeclaration?: CollectionSchemaDeclaration
): Promise<ResolvedCollectionPolicy> {
  const record = await getCollectionSchema(db, domain, collection);
  if (record) {
    return {
      syncStrategy: record.syncStrategy,
      governance: record.governance,
      enableEvidence: record.enableEvidence
    };
  }
  if (fallbackDeclaration) {
    return resolveSchemaDeclaration(fallbackDeclaration);
  }
  return DEFAULT_COLLECTION_POLICY;
}
