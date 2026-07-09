type TopicSubscribersFn = (topic: string) => string[];

/**
 * org-share 会话状态：
 * 负责 ACK 等待、ACK 竞态缓存，以及 topic 订阅者可见性等待。
 */
export class OrgShareSessionState {
  private readonly ackWaiters = new Map<string, () => void>();
  private readonly ackCache = new Set<string>();

  markAck(syncId: string): void {
    const done = this.ackWaiters.get(syncId);
    if (done) {
      done();
      return;
    }
    this.ackCache.add(syncId);
  }

  async waitAck(syncId: string, timeoutMs: number): Promise<boolean> {
    if (this.ackCache.has(syncId)) {
      this.ackCache.delete(syncId);
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(syncId);
        resolve(false);
      }, timeoutMs);

      this.ackWaiters.set(syncId, () => {
        clearTimeout(timer);
        this.ackWaiters.delete(syncId);
        resolve(true);
      });
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForTopicSubscriber(topic: string, targetPeerId: string | null, timeoutMs: number, getTopicSubscribers: TopicSubscribersFn): Promise<void> {
    if (!targetPeerId) {
      return;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const subscribers = getTopicSubscribers(topic);
      if (subscribers.includes(targetPeerId)) {
        console.log('[p2p][org-share] target subscriber ready', {
          topic,
          targetPeerId,
          subscribers
        });
        return;
      }
      await this.sleep(200);
    }

    console.warn('[p2p][org-share] target subscriber not ready before timeout', {
      topic,
      targetPeerId,
      subscribers: getTopicSubscribers(topic)
    });
  }
}
