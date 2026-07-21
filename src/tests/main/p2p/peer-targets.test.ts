import { describe, expect, it } from 'vitest';
import { buildDialTargets, extractPeerId, normalizePeerIdList } from '../../../main/p2p/peer-targets';

describe('peer-targets helpers', () => {
  it('extracts explicit peer id first', () => {
    expect(extractPeerId({ peerId: '  QmExplicit  ', addresses: ['/ip4/1.2.3.4/tcp/15002/ws/p2p/QmOther'] })).toBe('QmExplicit');
  });

  it('extracts destination peer id from circuit relay addresses', () => {
    // 中继地址尾段 /p2p/<destination> 才是目标节点，/p2p/<relay> 是中转
    expect(extractPeerId({
      addresses: ['/ip4/1.2.3.4/tcp/15002/ws/p2p/QmRelay/p2p-circuit/p2p/QmDestination']
    })).toBe('QmDestination');
  });

  it('returns null when no peer id can be derived', () => {
    expect(extractPeerId({ addresses: ['/ip4/1.2.3.4/tcp/15002/ws'] })).toBeNull();
  });

  it('keeps circuit relay dial targets intact without appending /p2p/', () => {
    const circuitAddr = '/ip4/1.2.3.4/tcp/15002/ws/p2p/QmRelay/p2p-circuit/p2p/QmDestination';
    const targets = buildDialTargets({ peerId: 'QmDestination', addresses: [circuitAddr] });

    expect(targets).toEqual([circuitAddr]);
  });

  it('appends /p2p/<peerId> candidates for bare addresses', () => {
    const targets = buildDialTargets({ peerId: 'QmTarget', addresses: ['/ip4/1.2.3.4/tcp/15002/ws/'] });

    expect(targets).toEqual([
      '/ip4/1.2.3.4/tcp/15002/ws/',
      '/ip4/1.2.3.4/tcp/15002/ws/p2p/QmTarget'
    ]);
  });

  it('normalizes mixed peer id lists to strings', () => {
    expect(normalizePeerIdList(['QmA', { toString: () => 'QmB' }, null, ''])).toEqual(['QmA', 'QmB']);
  });
});
