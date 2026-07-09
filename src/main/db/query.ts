import { LevelDB } from './base';

export async function queryRangeByPrefix(db: LevelDB, prefix: string) {
  return db.queryRange({ prefix, start: prefix, end: `${prefix}\xFF` });
}
