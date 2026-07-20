import { LevelDB } from './base';
import { DocumentCollection, CollectionQueryOptions, CollectionQueryResult } from './collection';
import { DOMAIN_PLUGIN_PREFIX } from './domain';
import { CollectionSchemaRecord, getCollectionSchema } from './schema';

export function assertPluginDomain(domain?: string | null): string {
  if (!domain || typeof domain !== 'string' || !domain.startsWith(DOMAIN_PLUGIN_PREFIX)) {
    throw new Error('Invalid plugin domain. Plugin domains must start with plugin:');
  }
  return domain;
}

export function getPluginCollection<T extends Record<string, unknown> = Record<string, unknown>>(
  db: LevelDB,
  domain: string,
  collection: string
): DocumentCollection<T> {
  assertPluginDomain(domain);
  return new DocumentCollection<T>(db, domain, collection, {
    enableEvidence: true,
    indexedFields: []
  });
}

/**
 * 获取已声明同步策略的插件集合（写路径专用）。
 * 设计文档 V2 §4.3.4：集合必须先经 sdk.docs.defineCollection 声明 syncStrategy，
 * 未声明的集合拒绝写入/删除。
 */
export async function getDeclaredPluginCollection<T extends Record<string, unknown> = Record<string, unknown>>(
  db: LevelDB,
  domain: string,
  collection: string
): Promise<{ coll: DocumentCollection<T>; schema: CollectionSchemaRecord }> {
  assertPluginDomain(domain);
  const schema = await getCollectionSchema(db, domain, collection);
  if (!schema) {
    throw new Error(
      `Collection "${collection}" in ${domain} has no declared syncStrategy. ` +
        'Declare it first via sdk.docs.defineCollection().'
    );
  }
  const coll = new DocumentCollection<T>(db, domain, collection, {
    syncStrategy: schema.syncStrategy,
    governance: schema.governance,
    enableEvidence: schema.enableEvidence,
    indexedFields: []
  });
  return { coll, schema };
}

export async function putPluginDoc<T extends Record<string, unknown>>(
  db: LevelDB,
  domain: string,
  collection: string,
  id: string,
  doc: T
): Promise<void> {
  const coll = getPluginCollection<T>(db, domain, collection);
  await coll.put(id, doc);
}

export async function getPluginDoc<T extends Record<string, unknown>>(
  db: LevelDB,
  domain: string,
  collection: string,
  id: string
): Promise<T | null> {
  const coll = getPluginCollection<T>(db, domain, collection);
  return coll.get(id);
}

export async function deletePluginDoc(
  db: LevelDB,
  domain: string,
  collection: string,
  id: string
): Promise<void> {
  const coll = getPluginCollection(db, domain, collection);
  await coll.delete(id);
}

export async function queryPluginDocs<T extends Record<string, unknown>>(
  db: LevelDB,
  domain: string,
  collection: string,
  options: CollectionQueryOptions = {}
): Promise<CollectionQueryResult<T>> {
  const coll = getPluginCollection<T>(db, domain, collection);
  return coll.query(options);
}
