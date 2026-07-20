import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeepaliveScheduler } from '../../../main/p2p/keepalive';

describe('KeepaliveScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the tick on interval and stops cleanly', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const scheduler = new KeepaliveScheduler('test', 1000, async () => {
      ticks += 1;
    });

    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(3500);
    expect(ticks).toBe(3);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).toBe(3);
  });

  it('never overlaps ticks and absorbs tick errors', async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const scheduler = new KeepaliveScheduler('test', 1000, async () => {
      calls += 1;
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      running -= 1;
      if (calls === 1) {
        throw new Error('boom');
      }
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();

    expect(maxConcurrent).toBe(1);
    expect(calls).toBeGreaterThan(1);
  });

  it('notifyResumed triggers an immediate tick without waiting for the interval', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const scheduler = new KeepaliveScheduler('test', 60_000, async () => {
      ticks += 1;
    });

    scheduler.start();
    scheduler.notifyResumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);

    scheduler.stop();
  });
});
