import net from 'net';
import { describe, expect, it } from 'vitest';
import { buildWsListenAddrs, isTcpPortAvailable, normalizePreferredPort, parseWsListenPort, pickListenPort, supportsIpv6 } from '../../../main/p2p/listen-port';

async function occupyIpv6Only(port: number): Promise<net.Server> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => resolve(server));
    server.listen({ port, host: '::', ipv6Only: true });
  });
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen({ port: 0, host: '0.0.0.0' });
  });
}

describe('listen-port helpers', () => {
  it('parses ws tcp port from multiaddrs', () => {
    const port = parseWsListenPort([
      '/ip4/127.0.0.1/tcp/49236/ws/p2p/12D3KooWxxxx',
      '/ip4/192.168.1.9/tcp/15002/ws/p2p/12D3KooWyyyy'
    ]);

    expect(port).toBe(49236);
  });

  it('parses ws tcp port from ipv6 multiaddrs', () => {
    const port = parseWsListenPort([
      '/ip6/::1/tcp/15002/ws/p2p/12D3KooWxxxx'
    ]);

    expect(port).toBe(15002);
  });

  it('returns null when ws tcp multiaddr is missing', () => {
    const port = parseWsListenPort([
      '/ip4/127.0.0.1/udp/9999/quic-v1/p2p/12D3KooWxxxx'
    ]);

    expect(port).toBeNull();
  });

  it('normalizes persisted preferred port safely', () => {
    expect(normalizePreferredPort('15002', 16000)).toBe(15002);
    expect(normalizePreferredPort('invalid', 16000)).toBe(16000);
    expect(normalizePreferredPort(0, 16000)).toBe(16000);
  });

  it('builds dual-stack listen addrs when ipv6 is enabled', () => {
    expect(buildWsListenAddrs(15002, true)).toEqual([
      '/ip4/0.0.0.0/tcp/15002/ws',
      '/ip6/::/tcp/15002/ws'
    ]);
  });

  it('builds ipv4-only listen addrs when ipv6 is disabled or port is ephemeral', () => {
    expect(buildWsListenAddrs(15002, false)).toEqual([
      '/ip4/0.0.0.0/tcp/15002/ws'
    ]);
    expect(buildWsListenAddrs(0, true)).toEqual([
      '/ip4/0.0.0.0/tcp/0/ws',
      '/ip6/::/tcp/0/ws'
    ]);
  });

  it('probes ipv6 availability and returns a boolean', async () => {
    expect(typeof await supportsIpv6()).toBe('boolean');
  });

  it('detects ports occupied by ipv6-only processes when dual-stack check is requested', async () => {
    if (!(await supportsIpv6())) {
      return;
    }
    const port = await findFreePort();
    const occupier = await occupyIpv6Only(port);
    try {
      // IPv4 单栈探测认为可用，但双栈探测必须判为不可用——
      // 否则双栈监听会在启动阶段对该端口 EADDRINUSE
      expect(await isTcpPortAvailable(port)).toBe(true);
      expect(await isTcpPortAvailable(port, true)).toBe(false);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  });

  it('pickListenPort skips ipv6-occupied ports when dual-stack check is requested', async () => {
    if (!(await supportsIpv6())) {
      return;
    }
    const port = await findFreePort();
    const occupier = await occupyIpv6Only(port);
    try {
      const picked = await pickListenPort(port, 2, true);
      expect(picked).not.toBe(port);
      expect(await isTcpPortAvailable(picked, true)).toBe(true);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  });
});
