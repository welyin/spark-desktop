import { writeFile } from 'fs/promises';
import type { LevelDB } from '../db/base';
import { KEY_RANGE_UPPER_BOUND } from './constants';

/**
 * 手动导出迁移：全库逻辑 dump 为单个 JSON 文件。
 *
 * 口径：容灾由 K 副本网络承担，本功能不做周期自动备份，只服务两类手动场景——
 * 1) 管理员手动清理旧数据前的"先转移备份"引导；2) 换机迁移。
 * 逻辑 dump 而非 LevelDB 目录拷贝：应用层一致（无文件锁问题）、跨机器可读、
 * 未来可配合独立工具做离线核验。
 *
 * 注：RootID 身份不在 LevelDB 中（root-identity.json 单独存放且经密码加密），
 * 本导出不包含身份信息；身份备份走助记词路径。
 */

export interface ExportDump {
  formatVersion: 1;
  app: 'spark-desktop';
  exportedAt: number;
  entries: Array<{ key: string; value: string }>;
}

/** 全库扫描生成导出对象（内存驻留；社区规模数据量可接受） */
export async function buildExportDump(db: LevelDB): Promise<ExportDump> {
  // end 取最大合法 UTF-8 码位，保证非 ASCII 键也被导出
  const rows = await db.queryRange({ prefix: '', end: KEY_RANGE_UPPER_BOUND });
  return {
    formatVersion: 1,
    app: 'spark-desktop',
    exportedAt: Date.now(),
    entries: rows.map((row) => ({ key: row.key, value: row.value }))
  };
}

/** 导出到指定文件路径，返回写入统计 */
export async function writeExportDump(db: LevelDB, filePath: string): Promise<{ path: string; entries: number; bytes: number }> {
  const dump = await buildExportDump(db);
  const text = JSON.stringify(dump);
  await writeFile(filePath, text, 'utf8');
  return { path: filePath, entries: dump.entries.length, bytes: Buffer.byteLength(text, 'utf8') };
}
