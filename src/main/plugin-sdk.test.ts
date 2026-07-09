import { describe, expect, it, vi } from 'vitest';
import { createPluginSDK, PluginSDK } from './plugin-sdk';

const mockIpc: any = {
  invoke: vi.fn()
};

describe('createPluginSDK', () => {
  it('should throw if current window is not a plugin domain', async () => {
    mockIpc.invoke.mockResolvedValueOnce({ domain: 'system' });
    await expect(createPluginSDK(mockIpc)).rejects.toThrow(/plugin.*domain/i);

    mockIpc.invoke.mockResolvedValueOnce({ domain: null });
    await expect(createPluginSDK(mockIpc)).rejects.toThrow(/plugin.*domain/i);

    mockIpc.invoke.mockResolvedValueOnce({ domain: 'plugin:' });
    await expect(createPluginSDK(mockIpc)).rejects.toThrow(/plugin.*domain/i);
  });

  it('should create sdk with domain from main process', async () => {
    mockIpc.invoke.mockResolvedValueOnce({ domain: 'plugin:test' });

    const sdk = await createPluginSDK(mockIpc);
    expect(sdk.domain).toBe('plugin:test');
    expect(typeof sdk.db.open).toBe('function');
    expect(typeof sdk.db.close).toBe('function');
    expect(typeof sdk.db.get).toBe('function');
    expect(typeof sdk.evidence.headHash).toBe('function');
    expect(typeof sdk.p2p.start).toBe('function');
  });

  it('should not accept caller-supplied domain (domain comes from main process only)', async () => {
    // 安全验证：createPluginSDK 不再接收 domain 参数，
    // 域身份完全由主进程通过 get-current-domain 返回
    mockIpc.invoke.mockResolvedValueOnce({ domain: 'plugin:demo' });

    const sdk = await createPluginSDK(mockIpc);

    // 验证 db.get 调用时不会额外传递 domain 参数
    mockIpc.invoke.mockResolvedValueOnce('test-value');
    await sdk.db.get('doc:plugin:demo:items:1');

    // invoke 应该只传了 channel 和 key，没有第三个 domain 参数
    const callArgs = mockIpc.invoke.mock.calls[mockIpc.invoke.mock.calls.length - 1];
    expect(callArgs.length).toBe(2); // ['db-get', key]
    expect(callArgs[0]).toBe('db-get');
    expect(callArgs[1]).toBe('doc:plugin:demo:items:1');
  });
});
