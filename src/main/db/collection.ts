import { LevelDBOperation, LevelDB, DocumentValue } from './base';
import { getP2PNode, isP2PInitialized } from '../p2p';
import { generateUpdatedMeta, metaKey, applyRemoteUpdate } from './sync';
import {
  CollectionSchemaDeclaration,
  ResolvedCollectionPolicy,
  SyncStrategy,
  resolveCollectionPolicy
} from './schema';
import {
  buildEvidenceDataHash,
  buildEvidenceMetaHash,
  buildEvidencePayloadHash,
  buildNextEvidenceEntry,
  evidenceBatchOperations
} from './evidence';

/**
 * 集合配置：可指定需要建立索引的字段列表
 * - `syncStrategy` / `governance` / `enableEvidence` 仅作为策略兜底声明，
 *   已持久化的集合声明（见 db/schema.ts）优先于此处配置
 */
export interface CollectionConfig {
  indexedFields?: string[];
  enableEvidence?: boolean;
  syncStrategy?: SyncStrategy;
  governance?: boolean;
}

/**
 * 条件查询中单个条件的定义
 * - `field`: 文档字段（支持点号访问嵌套字段）
 * - `value`: 要比较的值
 * - `op`: 比较操作，默认 eq（等于）
 */
export interface CollectionQueryFilter {
  field: string;
  value: string | number | boolean;
  op?: 'eq' | 'startsWith' | 'gt' | 'lt' | 'gte' | 'lte';
}

/**
 * 集合查询参数
 * - 支持按二级索引查询、分页（startAfterId + limit）、反向排序等
 */
export interface CollectionQueryOptions {
  indexName?: string;
  indexValue?: string | number | boolean;
  indexPrefix?: boolean;
  startAfterId?: string;
  limit?: number;
  reverse?: boolean;
  filter?: CollectionQueryFilter[];
}

/**
 * 集合查询结果：返回文档 id 列表和下一页游标
 */
export interface CollectionQueryResult<T extends DocumentValue = DocumentValue> {
  items: Array<{ id: string; data: T }>;
  nextCursor?: string;
}

/**
 * 单集合文档抽象，负责：
 * - 文档 CRUD（以 `doc:{domain}:{collection}:{id}` 存储）
 * - 二级索引维护（以 `idx:{domain}:{collection}:{indexName}:{indexValue}:{id}` 存储）
 * - 基于索引或主键的分页、条件查询
 * - 单集合事务（批量写入封装）
 */
export class DocumentCollection<T extends DocumentValue = DocumentValue> {
  private readonly keyPrefix: string;
  private readonly indexPrefixBase: string;
  private readonly indexedFields: string[];
  private readonly policyHint?: CollectionSchemaDeclaration;

  constructor(
    private readonly db: LevelDB,
    private readonly domain: string,
    private readonly collection: string,
    config: CollectionConfig = {}
  ) {
    this.keyPrefix = `doc:${domain}:${collection}:`;
    this.indexPrefixBase = `idx:${domain}:${collection}:`;
    this.indexedFields = config.indexedFields ?? [];
    if (config.syncStrategy || config.governance !== undefined || config.enableEvidence !== undefined) {
      this.policyHint = {
        // 历史上仅声明 enableEvidence 的调用方期望可覆盖语义，兜底策略按 lww 处理
        syncStrategy: config.syncStrategy ?? 'lww',
        governance: config.governance,
        enableEvidence: config.enableEvidence
      };
    }
  }

  /** 解析集合当前生效的同步策略：持久化声明优先，其次构造配置，最后退回默认（最安全） */
  private async resolvePolicy(): Promise<ResolvedCollectionPolicy> {
    return resolveCollectionPolicy(this.db, this.domain, this.collection, this.policyHint);
  }

  /** 同步策略声明副本，随同步消息携带，供远端节点在本地未声明时作为本次应用的兜底策略（不持久化） */
  private policyDeclaration(policy: ResolvedCollectionPolicy): CollectionSchemaDeclaration {
    return {
      syncStrategy: policy.syncStrategy,
      governance: policy.governance,
      enableEvidence: policy.enableEvidence
    };
  }

  /** 主键文档键 */
  private docKey(id: string) {
    return `${this.keyPrefix}${id}`;
  }

  /** 二级索引键 */
  private indexKey(indexName: string, indexValue: string, id: string) {
    return `${this.indexPrefixBase}${indexName}:${this.encodeIndex(indexValue)}:${id}`;
  }

  /** 二级索引前缀 */
  private indexPrefix(indexName: string) {
    return `${this.indexPrefixBase}${indexName}:`;
  }

  /** 对索引值进行编码，保证键安全 */
  private encodeIndex(value: string | number | boolean) {
    return encodeURIComponent(String(value));
  }

  /** 反序列化文档字符串为对象 */
  private decodeDocument(value: string): T {
    return JSON.parse(value) as T;
  }

  /** 根据配置的索引字段，从文档中构建索引映射（field -> value） */
  private buildIndexMap(doc: T | null): Map<string, string> {
    const map = new Map<string, string>();
    if (!doc) {
      return map;
    }

    for (const field of this.indexedFields) {
      const fieldValue = this.resolveFieldValue(doc, field);
      if (fieldValue === undefined || fieldValue === null) {
        continue;
      }
      map.set(field, String(fieldValue));
    }

    return map;
  }

  /** 支持点号访问的字段解析器（嵌套字段） */
  private resolveFieldValue(doc: DocumentValue, field: string) {
    const parts = field.split('.');
    let current: unknown = doc;
    for (const part of parts) {
      if (typeof current !== 'object' || current === null || !(part in current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** 获取文档，若不存在返回 null */
  async get(id: string): Promise<T | null> {
    const raw = await this.db.get(this.docKey(id));
    if (raw === null) {
      return null;
    }
    return this.decodeDocument(raw);
  }

  /** 写入/替换文档，同时维护二级索引的删除/新增；append-only 集合拒绝覆盖已存在的文档 */
  async put(id: string, doc: T): Promise<void> {
    const policy = await this.resolvePolicy();
    const existing = await this.get(id);
    if (policy.syncStrategy === 'append-only' && existing) {
      throw new Error(
        `Collection "${this.collection}" is append-only: document "${id}" already exists and cannot be overwritten`
      );
    }
    const oldIndexMap = this.buildIndexMap(existing);
    const newIndexMap = this.buildIndexMap(doc);
    const ops: LevelDBOperation[] = [{ type: 'put', key: this.docKey(id), value: JSON.stringify(doc) }];

    // 删除旧索引中已变化的项
    for (const [field, oldValue] of oldIndexMap.entries()) {
      if (!newIndexMap.has(field) || newIndexMap.get(field) !== oldValue) {
        ops.push({ type: 'del', key: this.indexKey(field, oldValue, id) });
      }
    }

    // 新增索引项
    for (const [field, newValue] of newIndexMap.entries()) {
      if (!oldIndexMap.has(field) || oldIndexMap.get(field) !== newValue) {
        ops.push({ type: 'put', key: this.indexKey(field, newValue, id), value: '' });
      }
    }

    // 生成并写入新版 meta（不直接写入，返回 meta 让 batch 一并提交）
    const nodeId = isP2PInitialized() ? getP2PNode().nodeId : 'local-node';
    const meta = await generateUpdatedMeta(this.db, nodeId, this.domain, this.collection, id);
    ops.push({ type: 'put', key: metaKey(this.domain, this.collection, id), value: JSON.stringify(meta) });

    if (policy.enableEvidence) {
      const evidenceEntry = await buildNextEvidenceEntry(this.db, {
        domain: this.domain,
        collection: this.collection,
        id,
        op: 'put',
        dataHash: buildEvidenceDataHash(this.domain, this.collection, id, 'put', buildEvidencePayloadHash(doc), buildEvidenceMetaHash(meta)),
        payloadHash: buildEvidencePayloadHash(doc),
        metaHash: buildEvidenceMetaHash(meta),
        timestamp: Date.now(),
        nodeId
      });
      ops.push(...evidenceBatchOperations(evidenceEntry));
    }

    await this.db.batch(ops);

    // 广播变更到 P2P（非阻塞），随消息携带策略声明供远端节点学习
    if (isP2PInitialized()) {
      try {
        await getP2PNode().broadcast('spark-sync', {
          type: 'update',
          domain: this.domain,
          collection: this.collection,
          id,
          payload: doc,
          meta,
          schema: this.policyDeclaration(policy)
        } as any);
      } catch (err) {
        console.warn('[collection] p2p broadcast failed', err);
      }
    }
  }

  /** 删除文档并清理对应索引；append-only 集合禁止删除 */
  async delete(id: string): Promise<void> {
    const policy = await this.resolvePolicy();
    if (policy.syncStrategy === 'append-only') {
      throw new Error(`Collection "${this.collection}" is append-only: documents cannot be deleted`);
    }
    const existing = await this.get(id);
    if (!existing) {
      return;
    }
    const ops: LevelDBOperation[] = [{ type: 'del', key: this.docKey(id) }];
    const indexMap = this.buildIndexMap(existing);
    for (const [field, value] of indexMap.entries()) {
      ops.push({ type: 'del', key: this.indexKey(field, value, id) });
    }

    // 生成新版 meta 并在 batch 中写入 tombstone
    const nodeId = isP2PInitialized() ? getP2PNode().nodeId : 'local-node';
    const meta = await generateUpdatedMeta(this.db, nodeId, this.domain, this.collection, id);
    const tombstoneMeta = { vv: meta.vv, ts: meta.ts, tombstone: true };
    ops.push({ type: 'put', key: metaKey(this.domain, this.collection, id), value: JSON.stringify(tombstoneMeta) });

    if (policy.enableEvidence) {
      const evidenceEntry = await buildNextEvidenceEntry(this.db, {
        domain: this.domain,
        collection: this.collection,
        id,
        op: 'delete',
        dataHash: buildEvidenceDataHash(this.domain, this.collection, id, 'delete', null, buildEvidenceMetaHash(tombstoneMeta)),
        payloadHash: null,
        metaHash: buildEvidenceMetaHash(tombstoneMeta),
        timestamp: Date.now(),
        nodeId
      });
      ops.push(...evidenceBatchOperations(evidenceEntry));
    }

    await this.db.batch(ops);

    // 广播删除事件，随消息携带策略声明供远端节点学习
    if (isP2PInitialized()) {
      try {
        await getP2PNode().broadcast('spark-sync', {
          type: 'delete',
          domain: this.domain,
          collection: this.collection,
          id,
          payload: null,
          meta,
          schema: this.policyDeclaration(policy)
        } as any);
      } catch (err) {
        console.warn('[collection] p2p broadcast delete failed', err);
      }
    }
  }

  /**
   * 查询集合：支持按二级索引或主键范围扫描，并在内存中应用 filter 条件
   * - 当提供 indexName 时，按索引遍历并通过 id 回读主文档以返回完整数据
   */
  async query(options: CollectionQueryOptions = {}): Promise<CollectionQueryResult<T>> {
    const limit = options.limit ?? 50;
    const reverse = options.reverse ?? false;
    const filter = options.filter ?? [];
    const matchesFilter = (doc: T) => {
      return filter.every((condition) => {
        const value = this.resolveFieldValue(doc, condition.field);
        if (value === undefined || value === null) {
          return false;
        }
        const actual = String(value);
        const expected = String(condition.value);
        switch (condition.op) {
          case 'startsWith':
            return actual.startsWith(expected);
          case 'gt':
            return actual > expected;
          case 'lt':
            return actual < expected;
          case 'gte':
            return actual >= expected;
          case 'lte':
            return actual <= expected;
          case 'eq':
          default:
            return actual === expected;
        }
      });
    };

    let entries: Array<{ key: string; value: string }> = [];
    const indexQuery = Boolean(options.indexName);

    if (indexQuery) {
      const indexPrefix = this.indexPrefix(options.indexName!);
      const encodedValue = options.indexValue !== undefined ? this.encodeIndex(options.indexValue) : undefined;
      const exactValueSearch = encodedValue !== undefined && !options.indexPrefix;
      const start = exactValueSearch
        ? `${indexPrefix}${encodedValue}:`
        : encodedValue !== undefined
        ? `${indexPrefix}${encodedValue}`
        : indexPrefix;
      const end = exactValueSearch
        ? `${indexPrefix}${encodedValue}:\xFF`
        : encodedValue !== undefined
        ? `${indexPrefix}${encodedValue}\xFF`
        : `${indexPrefix}\xFF`;
      const startAfter = options.startAfterId ? `${start}${options.startAfterId}\x00` : start;

      entries = await this.db.queryRange({
        prefix: indexPrefix,
        start: startAfter,
        end,
        limit,
        reverse
      });
    } else {
      const start = options.startAfterId ? `${this.docKey(options.startAfterId)}\x00` : this.keyPrefix;
      const end = `${this.keyPrefix}\xFF`;
      entries = await this.db.queryRange({
        prefix: this.keyPrefix,
        start,
        end,
        limit,
        reverse
      });
    }

    const result: CollectionQueryResult<T> = { items: [] };
    for (const { key, value } of entries) {
      const docId = this.parseDocumentId(key);
      if (!docId) {
        continue;
      }

      const data = indexQuery ? await this.get(docId) : this.decodeDocument(value);
      if (!data) {
        continue;
      }

      if (matchesFilter(data)) {
        result.items.push({ id: docId, data });
      }
    }

    if (result.items.length === limit) {
      result.nextCursor = result.items[result.items.length - 1].id;
    }

    return result;
  }

  /**
   * 在单集合范围内执行事务：事务函数收到一个 Transaction 封装，提交后会一次性应用所有变更
   */
  async transaction<R>(action: (tx: CollectionTransaction<T>) => Promise<R> | R): Promise<R> {
    const transaction = new CollectionTransaction<T>(this);
    const result = await action(transaction);
    await transaction.commit();
    return result;
  }

  /** 从存储键中解析出文档 id（支持主键与索引键） */
  private parseDocumentId(key: string): string | null {
    if (key.startsWith(this.keyPrefix)) {
      return key.slice(this.keyPrefix.length);
    }

    if (!key.startsWith(this.indexPrefixBase)) {
      return null;
    }

    const suffix = key.slice(this.indexPrefixBase.length);
    const parts = suffix.split(':');
    if (parts.length < 4) {
      return null;
    }
    return parts[parts.length - 1];
  }
}

/**
 * 集合级事务封装：支持 get/put/delete 的临时操作缓存，最后一次性 commit 到底层 DB
 */
class CollectionTransaction<T extends DocumentValue = DocumentValue> {
  private readonly pending = new Map<
    string,
    {
      type: 'put' | 'del';
      doc?: T;
      oldIndex: Map<string, string>;
      newIndex: Map<string, string>;
    }
  >();
  private readonly readCache = new Map<string, T | null>();

  constructor(private readonly collection: DocumentCollection<T>) {}

  /** 优先返回事务缓存中的读，或从底层读并缓存 */
  async get(id: string): Promise<T | null> {
    if (this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      return entry.type === 'put' ? entry.doc ?? null : null;
    }

    if (this.readCache.has(id)) {
      return this.readCache.get(id) ?? null;
    }

    const existing = await this.collection.get(id);
    this.readCache.set(id, existing);
    return existing;
  }

  /** 在事务中写入文档（仅缓存，提交时应用）；append-only 集合拒绝覆盖已存在的文档 */
  async put(id: string, doc: T): Promise<void> {
    const existing = await this.get(id);
    const policy = await this.collection['resolvePolicy']();
    if (policy.syncStrategy === 'append-only' && existing) {
      throw new Error(
        `Collection "${this.collection['collection']}" is append-only: document "${id}" already exists and cannot be overwritten`
      );
    }
    const oldIndex = this.collection['buildIndexMap'](existing);
    const newIndex = this.collection['buildIndexMap'](doc);
    this.pending.set(id, { type: 'put', doc, oldIndex, newIndex });
    this.readCache.set(id, doc);
  }

  /** 在事务中删除文档（仅缓存，提交时应用）；append-only 集合禁止删除 */
  async delete(id: string): Promise<void> {
    const policy = await this.collection['resolvePolicy']();
    if (policy.syncStrategy === 'append-only') {
      throw new Error(`Collection "${this.collection['collection']}" is append-only: documents cannot be deleted`);
    }
    const existing = await this.get(id);
    if (!existing) {
      this.pending.set(id, { type: 'del', oldIndex: new Map(), newIndex: new Map() });
      return;
    }
    const oldIndex = this.collection['buildIndexMap'](existing);
    this.pending.set(id, { type: 'del', oldIndex, newIndex: new Map() });
    this.readCache.set(id, null);
  }

  /** 将事务中所有变更打包为底层 batch 并提交，保证单集合原子性 */
  async commit(): Promise<void> {
    const ops: LevelDBOperation[] = [];
    for (const [id, entry] of this.pending.entries()) {
      if (entry.type === 'put' && entry.doc) {
        ops.push({ type: 'put', key: this.collection['docKey'](id), value: JSON.stringify(entry.doc) });
        for (const [field, value] of entry.oldIndex.entries()) {
          if (!entry.newIndex.has(field) || entry.newIndex.get(field) !== value) {
            ops.push({ type: 'del', key: this.collection['indexKey'](field, value, id) });
          }
        }
        for (const [field, value] of entry.newIndex.entries()) {
          if (!entry.oldIndex.has(field) || entry.oldIndex.get(field) !== value) {
            ops.push({ type: 'put', key: this.collection['indexKey'](field, value, id), value: '' });
          }
        }
      }

      if (entry.type === 'del') {
        ops.push({ type: 'del', key: this.collection['docKey'](id) });
        for (const [field, value] of entry.oldIndex.entries()) {
          ops.push({ type: 'del', key: this.collection['indexKey'](field, value, id) });
        }
      }
    }

    if (ops.length > 0) {
      await this.collection['db'].batch(ops);
    }
  }
}
