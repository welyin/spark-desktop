import { describe, expect, it } from 'vitest';
import { normalizePreferredPort, parseWsListenPort } from '../../../main/p2p/listen-port';

describe('listen-port helpers', () => {
  it('parses ws tcp port from multiaddrs', () => {
    const port = parseWsListenPort([
      '/ip4/127.0.0.1/tcp/49236/ws/p2p/12D3KooWxxxx',
      '/ip4/192.168.1.9/tcp/15002/ws/p2p/12D3KooWyyyy'
    ]);

    expect(port).toBe(49236);
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
});
