import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { RootIdentityManager, verifyEd25519Signature } from '../../../main/identity/root-id';

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

  it('signs with domain identity and verifies roundtrip', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'root-id-'));
    const storage = path.join(tmp, 'root-identity.json');
    const manager = new RootIdentityManager(storage);

    await manager.initialize('domain-sign-password');

    const sig = manager.signWithDomainIdentity('plugin:demo', 'hello-vote');
    expect(sig.domain).toBe('plugin:demo');
    expect(sig.signature.length).toBeGreaterThan(0);

    // 签名公钥与派生的域身份公钥一致
    const derived = manager.deriveDomainIdentity('plugin:demo');
    expect(sig.publicKey).toBe(derived.publicKey);
    expect(sig.domainId).toBe(derived.domainId);

    // 验签：正确 payload 通过；篡改 payload / 他域公钥不通过
    expect(verifyEd25519Signature('hello-vote', sig.signature, sig.publicKey)).toBe(true);
    expect(verifyEd25519Signature('tampered', sig.signature, sig.publicKey)).toBe(false);

    const other = manager.signWithDomainIdentity('plugin:another', 'hello-vote');
    expect(other.publicKey).not.toBe(sig.publicKey);
    expect(verifyEd25519Signature('hello-vote', sig.signature, other.publicKey)).toBe(false);

    // 域签名与根签名使用不同密钥（根身份不对插件暴露）
    const rootSig = manager.sign('hello-vote');
    expect(verifyEd25519Signature('hello-vote', rootSig.signature, sig.publicKey)).toBe(false);

    // 锁定后不可签名
    manager.lock();
    expect(() => manager.signWithDomainIdentity('plugin:demo', 'x')).toThrow(/locked/i);

    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects malformed signatures and keys', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'root-id-'));
    const storage = path.join(tmp, 'root-identity.json');
    const manager = new RootIdentityManager(storage);

    await manager.initialize('verify-edge-password');
    const sig = manager.signWithDomainIdentity('plugin:demo', 'payload');

    expect(verifyEd25519Signature('payload', 'not-base64!!!', sig.publicKey)).toBe(false);
    expect(verifyEd25519Signature('payload', sig.signature, 'not-base64!!!')).toBe(false);
    expect(verifyEd25519Signature('payload', Buffer.from('short').toString('base64'), sig.publicKey)).toBe(false);

    await rm(tmp, { recursive: true, force: true });
  });
});