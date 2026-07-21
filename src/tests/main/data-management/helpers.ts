/**
 * data-management 测试共享的内存 LevelDB 替身。
 * 支持 get/put/del/batch/queryRange（start/end 区间语义与 main/db/base.ts 一致）。
 */
export class MemoryDb {
  private readonly store = new Map<string, string>();

  async open(): Promise<void> {}

  get path(): string {
    return '/tmp/spark-test-db';
  }

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async batch(ops: Array<{ type: 'put' | 'del'; key: string; value?: string }>): Promise<void> {
    for (const op of ops) {
      if (op.type === 'put') {
        this.store.set(op.key, op.value ?? '');
      } else {
        this.store.delete(op.key);
      }
    }
  }

  async queryRange(options: { prefix: string; start?: string; end?: string; limit?: number; reverse?: boolean }): Promise<Array<{ key: string; value: string }>> {
    const start = options.start ?? options.prefix;
    const end = options.end ?? `${options.prefix}\xFF`;
    let rows = [...this.store.entries()]
      .filter(([key]) => key >= start && key < end)
      .sort(([a], [b]) => a.localeCompare(b));
    if (options.reverse) {
      rows = rows.reverse();
    }
    if (typeof options.limit === 'number') {
      rows = rows.slice(0, options.limit);
    }
    return rows.map(([key, value]) => ({ key, value }));
  }

  /** 测试断言用：全部键列表 */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }
}

/** 测试集合存根：与 db/sync.test.ts 口径一致（docKey/indexKey/buildIndexMap 私有方法按索引访问） */
export function createCollectionStub(domain: string, collection: string) {
  const docs = new Map<string, unknown>();
  return {
    async get(id: string) {
      return docs.has(id) ? docs.get(id) : null;
    },
    async setDoc(id: string, doc: unknown) {
      docs.set(id, doc);
    },
    docKey(id: string) {
      return `doc:${domain}:${collection}:${id}`;
    },
    indexKey(field: string, value: string, id: string) {
      return `idx:${domain}:${collection}:${field}:${value}:${id}`;
    },
    buildIndexMap(doc: any) {
      const map = new Map<string, string>();
      if (!doc) return map;
      if (doc.name) map.set('name', String(doc.name));
      return map;
    }
  } as any;
}
