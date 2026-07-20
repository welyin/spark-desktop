/**
 * 通用保活调度器
 *
 * 以固定间隔执行异步 tick：
 * - 防重入：上一次 tick 未结束时跳过本次（tick 内部自行控制上限，叠加只会拖慢）；
 * - 支持 notifyResumed() 立即补跑（系统从休眠恢复、网络变化后调用）；
 * - start/stop 幂等，便于装配层在 db-open/db-close 生命周期中反复调用。
 */
export class KeepaliveScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // 不阻止进程退出（Electron 主进程常驻，此处仅为防御）
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** 立即补跑一次（休眠恢复等场景）；tick 执行中则跳过，等下个周期。 */
  notifyResumed(): void {
    void this.runOnce();
  }

  private async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch (error) {
      console.warn(`[keepalive][${this.name}] tick failed`, error);
    } finally {
      this.running = false;
    }
  }
}
