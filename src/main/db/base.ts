import { app } from 'electron';
import { BatchOperation, Level } from 'level';
import path from 'path';

/**
 * LevelDB 批量操作项（用于 batch）
 * - `type`: 操作类型，'put' 表示写入，'del' 表示删除
 * - `key`: 操作对应的键
 * - `value`: 可选，写入时的值
 */
export interface LevelDBOperation {
  type: 'put' | 'del';
  key: string;
  value?: string;
}

/**
 * 文档的通用值类型，表示一个键值对象
 */
export type DocumentValue = Record<string, unknown>;

/**
 * LevelDB 基础封装类，提供打开/关闭/读写/批量及范围查询等基础能力
 */
export class LevelDB {
  private db?: Level<string, string>;
  private currentPath: string;
  private openPromise: Promise<void> | null = null;
  private opened = false;

  /**
   * 构造函数，传入数据库目录名（默认 'spark-leveldb'）
   */
  constructor(name = 'spark-leveldb') {
    this.currentPath = path.join(app.getPath('userData'), name);
  }

  /** 当前数据库路径 */
  get path() {
    return this.currentPath;
  }

  /** 是否已经打开 */
  get isOpen() {
    return this.opened;
  }

  /** 确保数据库已打开，否则抛出错误 */
  private ensureOpen() {
    if (!this.db || !this.opened) {
      throw new Error('LevelDB is not open');
    }
    return this.db;
  }

  /**
   * 打开数据库（若已打开则不重复打开）
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }

    if (this.openPromise) {
      await this.openPromise;
      return;
    }

    if (!this.db) {
      // 创建并打开数据库实例
      this.db = new Level<string, string>(this.currentPath, {
        valueEncoding: 'utf8'
      });
    }

    this.openPromise = (async () => {
      try {
        await this.db!.open();
        this.opened = true;
      } catch (error) {
        this.cleanup();
        throw new Error(`Failed to open LevelDB at ${this.currentPath}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.openPromise = null;
      }
    })();

    await this.openPromise;
  }

  /**
   * 关闭数据库并清理内部引用
   */
  async close(): Promise<void> {
    if (this.openPromise) {
      await this.openPromise;
    }

    if (!this.db) {
      return;
    }

    try {
      await this.db.close();
    } catch (error) {
      throw new Error(`Failed to close LevelDB: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.cleanup();
    }
  }

  /**
   * 读取指定键的值，若不存在返回 null
   */
  async get(key: string): Promise<string | null> {
    const db = this.ensureOpen();
    try {
      return await db.get(key);
    } catch (error) {
      if (error && typeof error === 'object' && 'notFound' in error) {
        return null;
      }
      throw new Error(`LevelDB get(${key}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 写入键值 */
  async put(key: string, value: string): Promise<void> {
    const db = this.ensureOpen();
    try {
      await db.put(key, value);
    } catch (error) {
      throw new Error(`LevelDB put(${key}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 删除键 */
  async del(key: string): Promise<void> {
    const db = this.ensureOpen();
    try {
      await db.del(key);
    } catch (error) {
      throw new Error(`LevelDB del(${key}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 原子批量操作，接收通用 LevelDBOperation 并转换为 level 的批量类型
   */
  async batch(operations: LevelDBOperation[]): Promise<void> {
    const db = this.ensureOpen();
    const ops = operations.map<BatchOperation<typeof db, string, string>>((operation) => {
      // 将通用操作转换为 level 包所需的批量操作类型
      if (operation.type === 'put') {
        return { type: 'put' as const, key: operation.key, value: operation.value ?? '' };
      }
      return { type: 'del' as const, key: operation.key };
    });

    try {
      await db.batch(ops);
    } catch (error) {
      throw new Error(`LevelDB batch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 基于 iterator 的范围查询，按键排序返回键值对数组
   */
  async queryRange(options: {
    prefix: string;
    start?: string;
    end?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Array<{ key: string; value: string }>> {
    const db = this.ensureOpen();
    const items: Array<{ key: string; value: string }> = [];
    const iterator = db.iterator({
      gte: options.start ?? options.prefix,
      lt: options.end ?? `${options.prefix}\xFF`,
      limit: options.limit,
      reverse: options.reverse,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8'
    });

    // 使用 iterator 进行范围遍历，保证按键排序读取
    try {
      for await (const entry of iterator as AsyncIterable<[string, string]>) {
        const [key, value] = entry;
        items.push({ key, value });
      }
    } finally {
      // 关闭 iterator 释放资源
      if (typeof (iterator as any).close === 'function') {
        await (iterator as any).close();
      }
    }

    return items;
  }

  /** 清理内部 db 引用 */
  private cleanup() {
    this.db = undefined;
    this.openPromise = null;
    this.opened = false;
  }
}

/** 默认导出一个共享的 LevelDB 实例，方便主进程直接使用 */
export const levelDB = new LevelDB();
