import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { RootIdentityManager } from '../../../main/identity/root-id';

describe('RootIdentityManager', () => {
  it('initializes, signs, locks and unlocks from encrypted local storage', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'root-id-'));
    const storage = path.join(tmp, 'root-identity.json');
    const manager = new RootIdentityManager(storage);

    const init = await manager.initialize('strong-password-123');
    expect(init.rootId.length).toBeGreaterThan(0);
    expect(init.mnemonic.split(' ').length).toBe(24);

    const sig = manager.sign('payload-1');
    expect(sig.rootId).toBe(init.rootId);
    expect(sig.signature.length).toBeGreaterThan(0);

    manager.lock();
    expect(() => manager.sign('payload-2')).toThrow(/locked/i);

    const unlocked = await manager.unlock('strong-password-123');
    expect(unlocked.rootId).toBe(init.rootId);

    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects unlock with wrong password', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'root-id-'));
    const storage = path.join(tmp, 'root-identity.json');
    const manager = new RootIdentityManager(storage);

    await manager.initialize('correct-password');
    manager.lock();

    await expect(manager.unlock('wrong-password')).rejects.toThrow(/invalid password/i);
    await rm(tmp, { recursive: true, force: true });
  });

  it('derives deterministic domain identities from unlocked root identity', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'root-id-'));
    const storage = path.join(tmp, 'root-identity.json');
    const manager = new RootIdentityManager(storage);

    await manager.initialize('derivation-password');
    const d1 = manager.deriveDomainIdentity('plugin:demo');
    const d2 = manager.deriveDomainIdentity('plugin:demo');
    const d3 = manager.deriveDomainIdentity('plugin:another');

    expect(d1.domainId).toBe(d2.domainId);
    expect(d1.publicKey).toBe(d2.publicKey);
    expect(d1.domainId).not.toBe(d3.domainId);

    await rm(tmp, { recursive: true, force: true });
  });
});