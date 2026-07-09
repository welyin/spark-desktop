import { describe, expect, it } from 'vitest';
import { PeerActivityStore } from '../../../main/p2p/peer-activity-store';
import type { PeerNodeInfo } from '../../../main/p2p/types';

class MemoryDb {
  private readonly store = new Map<string, string>();

  async open(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async queryRange(options: { prefix: string; start?: string; end?: string }): Promise<Array<{ key: string; value: string }>> {
    return [...this.store.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
  }
}

function extractPeerId(nodeInfo: PeerNodeInfo): string | null {
  return nodeInfo.peerId ?? null;
}

describe('PeerActivityStore', () => {
  it('removes fully inactive peers after 10 consecutive failures', async () => {
    const db = new MemoryDb() as any;
    const store = new PeerActivityStore(db, extractPeerId);
    const node: PeerNodeInfo = {
      peerId: 'QmInactivePeer',
      addresses: ['/ip4/127.0.0.1/tcp/12000/ws']
    };

    for (let i = 0; i < 10; i += 1) {
      await store.rememberNodeInfo(node, 'failure', new Error(`fail-${i}`));
    }

    const persisted = await db.get('p2p:peer:record:QmInactivePeer');
    expect(persisted).toBeNull();
  });

  it('does not remove peers with successful activity history', async () => {
    const db = new MemoryDb() as any;
    const store = new PeerActivityStore(db, extractPeerId);
    const node: PeerNodeInfo = {
      peerId: 'QmPreviouslyActivePeer',
      addresses: ['/ip4/127.0.0.1/tcp/12001/ws']
    };

    await store.rememberNodeInfo(node, 'success');
    for (let i = 0; i < 12; i += 1) {
      await store.rememberNodeInfo(node, 'failure', new Error(`fail-${i}`));
    }

    const persisted = await db.get('p2p:peer:record:QmPreviouslyActivePeer');
    expect(persisted).not.toBeNull();
    const record = JSON.parse(persisted!);
    expect(record.successCount).toBe(1);
    expect(record.failureCount).toBe(12);
    expect(record.consecutiveFailureCount).toBeGreaterThanOrEqual(10);
  });
});
