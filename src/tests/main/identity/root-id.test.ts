import { mkdtemp, readFile, rm, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import * as bip39 from 'bip39';
import { describe, expect, it } from 'vitest';
import {
  RootIdentityManager,
  findInvalidMnemonicWords,
  splitMnemonicInput,
  verifyEd25519Signature
} from '../../../main/identity/root-id';

const makeTmp = () => mkdtemp(path.join(os.tmpdir(), 'root-id-'));
const identityFile = (baseDir: string, rootId: string) => path.join(baseDir, 'identities', `${rootId}.json`);

describe('RootIdentityManager', () => {
  it('initializes, signs, locks and unlocks from encrypted local storage', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

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
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    await manager.initialize('correct-password');
    manager.lock();

    await expect(manager.unlock('wrong-password')).rejects.toThrow(/invalid password/i);
    await rm(tmp, { recursive: true, force: true });
  });

  it('derives deterministic domain identities from unlocked root identity', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

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
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

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
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    await manager.initialize('verify-edge-password');
    const sig = manager.signWithDomainIdentity('plugin:demo', 'payload');

    expect(verifyEd25519Signature('payload', 'not-base64!!!', sig.publicKey)).toBe(false);
    expect(verifyEd25519Signature('payload', sig.signature, 'not-base64!!!')).toBe(false);
    expect(verifyEd25519Signature('payload', Buffer.from('short').toString('base64'), sig.publicKey)).toBe(false);

    await rm(tmp, { recursive: true, force: true });
  });
});

describe('RootIdentityManager v2 格式与中文助记词', () => {
  it('stores v2 (scrypt + aes-256-gcm) with chinese_simplified wordlist and 24 hanzi mnemonic', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    const init = await manager.initialize('strong-password-123');

    // 24 个汉字且均在中文简体词表内
    const words = init.mnemonic.split(' ');
    expect(words.length).toBe(24);
    const wordlist = bip39.wordlists.chinese_simplified;
    for (const word of words) {
      expect(wordlist.includes(word)).toBe(true);
    }
    expect(bip39.validateMnemonic(init.mnemonic, wordlist)).toBe(true);

    // 落盘格式：v2 自描述，每身份一文件
    const stored = JSON.parse(await readFile(identityFile(tmp, init.rootId), 'utf8'));
    expect(stored.version).toBe(2);
    expect(stored.wordlist).toBe('chinese_simplified');
    expect(stored.kdf.name).toBe('scrypt');
    expect(stored.kdf.N).toBeGreaterThanOrEqual(32768);
    expect(stored.encryption.algorithm).toBe('aes-256-gcm');
    expect(typeof stored.encryption.tag).toBe('string');

    await rm(tmp, { recursive: true, force: true });
  });

  it('reveals mnemonic with correct password and rejects wrong password', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    const init = await manager.initialize('reveal-password-1');
    manager.lock();

    const revealed = await manager.revealMnemonic('reveal-password-1');
    expect(revealed.mnemonic).toBe(init.mnemonic);
    await expect(manager.revealMnemonic('wrong-password')).rejects.toThrow(/invalid password/i);

    await rm(tmp, { recursive: true, force: true });
  });

  it('migrates legacy single-file identity (v1 pbkdf2 + aes-256-cbc) into identities/', async () => {
    const tmpA = await makeTmp();
    const tmpB = await makeTmp();

    // 用 v2 管理器产出秘密与 rootId，再以旧版单文件 v1 加密格式手工落盘
    const managerA = new RootIdentityManager(tmpA);
    const init = await managerA.initialize('legacy-password-1');
    const secret = { mnemonic: init.mnemonic, derivationPath: `m/44'/607'/0'/0'/0'` };
    const v2Stored = JSON.parse(await readFile(identityFile(tmpA, init.rootId), 'utf8'));

    const salt = randomBytes(16);
    const iv = randomBytes(16);
    const key = pbkdf2Sync('legacy-password-1', salt, 210_000, 32, 'sha512');
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    const legacyPayload = {
      version: 1,
      rootId: v2Stored.rootId,
      publicKey: v2Stored.publicKey,
      createdAt: v2Stored.createdAt,
      kdf: { salt: salt.toString('base64'), iterations: 210_000, keyLen: 32, digest: 'sha512' },
      encryption: { iv: iv.toString('base64'), algorithm: 'aes-256-cbc', ciphertext: ciphertext.toString('base64') }
    };
    await writeFile(path.join(tmpB, 'root-identity.json'), JSON.stringify(legacyPayload, null, 2), 'utf8');

    // 旧文件应在首次访问时迁移到 identities/<rootId>.json 并可直接解锁
    const managerB = new RootIdentityManager(tmpB);
    const unlocked = await managerB.unlock('legacy-password-1');
    expect(unlocked.rootId).toBe(init.rootId);
    expect(() => managerB.sign('payload')).not.toThrow();

    await access(identityFile(tmpB, init.rootId)); // 迁移后的文件存在
    await expect(access(path.join(tmpB, 'root-identity.json'))).rejects.toThrow(); // 旧文件已移除
    const identities = await managerB.listIdentities();
    expect(identities).toEqual([{ rootId: init.rootId, createdAt: v2Stored.createdAt, active: true }]);

    await rm(tmpA, { recursive: true, force: true });
    await rm(tmpB, { recursive: true, force: true });
  });
});

describe('RootIdentityManager 多用户', () => {
  it('registers multiple identities, tracks active pointer and switches unlock target', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    const userA = await manager.initialize('password-a-123');
    const userB = await manager.initialize('password-b-123');

    // 注册后活跃身份为最后注册者
    let identities = await manager.listIdentities();
    expect(identities.map((item) => item.rootId).sort()).toEqual([userA.rootId, userB.rootId].sort());
    expect(identities.find((item) => item.rootId === userB.rootId)?.active).toBe(true);
    expect((await manager.getStatus()).rootId).toBe(userB.rootId);

    // 切换登录目标到 A：setActive 只改指针，unlock 带 rootId 直接指定
    manager.lock();
    await manager.setActiveIdentity(userA.rootId);
    identities = await manager.listIdentities();
    expect(identities.find((item) => item.rootId === userA.rootId)?.active).toBe(true);

    const unlockedA = await manager.unlock('password-a-123');
    expect(unlockedA.rootId).toBe(userA.rootId);
    expect(() => manager.sign('x')).not.toThrow();

    // 显式指定 rootId 解锁 B；A 的密码对 B 无效
    manager.lock();
    await expect(manager.unlock('password-a-123', userB.rootId)).rejects.toThrow(/invalid password/i);
    const unlockedB = await manager.unlock('password-b-123', userB.rootId);
    expect(unlockedB.rootId).toBe(userB.rootId);
    expect((await manager.getStatus()).rootId).toBe(userB.rootId);

    // 切换不存在的账号被拒绝
    await expect(manager.setActiveIdentity('not-a-root-id')).rejects.toThrow(/不在本设备/);

    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects recovering an identity that already exists on this device', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    const init = await manager.initialize('origin-password-1');
    manager.lock();

    await expect(manager.recoverFromMnemonic(init.mnemonic, 'new-password-123')).rejects.toThrow(/已在本设备/);
    const { payload } = await manager.getEncryptedBackupPayload();
    await expect(manager.recoverFromBackup(payload, 'origin-password-1')).rejects.toThrow(/已在本设备/);

    await rm(tmp, { recursive: true, force: true });
  });
});

describe('RootIdentityManager 备份与恢复', () => {
  it('recovers from chinese mnemonic (spaced and continuous input) to the same rootId', async () => {
    const tmpA = await makeTmp();
    const tmpB = await makeTmp();
    const tmpC = await makeTmp();

    const managerA = new RootIdentityManager(tmpA);
    const init = await managerA.initialize('origin-password-1');

    // 空格分隔输入
    const managerB = new RootIdentityManager(tmpB);
    const recoveredB = await managerB.recoverFromMnemonic(init.mnemonic, 'new-password-123');
    expect(recoveredB.rootId).toBe(init.rootId);
    expect(() => managerB.sign('x')).not.toThrow();

    // 连续书写输入（无空格）
    const managerC = new RootIdentityManager(tmpC);
    const recoveredC = await managerC.recoverFromMnemonic(init.mnemonic.split(' ').join(''), 'new-password-123');
    expect(recoveredC.rootId).toBe(init.rootId);

    // 恢复后可再次导出相同助记词
    const revealed = await managerB.revealMnemonic('new-password-123');
    expect(revealed.mnemonic).toBe(init.mnemonic);

    await rm(tmpA, { recursive: true, force: true });
    await rm(tmpB, { recursive: true, force: true });
    await rm(tmpC, { recursive: true, force: true });
  });

  it('rejects invalid mnemonic recovery input', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    // 错字（词表外）
    const badWords = bip39.generateMnemonic(256, undefined, bip39.wordlists.chinese_simplified).split(' ');
    badWords[0] = '龘';
    await expect(manager.recoverFromMnemonic(badWords.join(' '), 'new-password-123')).rejects.toThrow(/校验失败/);
    // 字数不足
    await expect(manager.recoverFromMnemonic('的一是在', 'new-password-123')).rejects.toThrow(/校验失败/);
    // 短密码
    const valid = bip39.generateMnemonic(256, undefined, bip39.wordlists.chinese_simplified);
    await expect(manager.recoverFromMnemonic(valid, 'short')).rejects.toThrow(/at least 8/i);

    await rm(tmp, { recursive: true, force: true });
  });

  it('recovers legacy english mnemonics and records the english wordlist', async () => {
    const tmpA = await makeTmp();
    const tmpB = await makeTmp();

    // 模拟 v1 时代的英文助记词（旧版用默认英文词表生成）
    const englishMnemonic = bip39.generateMnemonic(256);

    const managerA = new RootIdentityManager(tmpA);
    const recoveredA = await managerA.recoverFromMnemonic(englishMnemonic, 'new-password-123');

    // 同一英文助记词在另一设备恢复出同一 rootId
    const managerB = new RootIdentityManager(tmpB);
    const recoveredB = await managerB.recoverFromMnemonic(englishMnemonic, 'new-password-123');
    expect(recoveredB.rootId).toBe(recoveredA.rootId);

    // 词表名记入身份文件；可正常解锁与查看助记词
    const stored = JSON.parse(await readFile(identityFile(tmpA, recoveredA.rootId), 'utf8'));
    expect(stored.wordlist).toBe('english');
    managerA.lock();
    await managerA.unlock('new-password-123');
    const revealed = await managerA.revealMnemonic('new-password-123');
    expect(revealed.mnemonic).toBe(englishMnemonic);

    await rm(tmpA, { recursive: true, force: true });
    await rm(tmpB, { recursive: true, force: true });
  });

  it('rejects mixed-language or corrupted mnemonics', async () => {
    const tmp = await makeTmp();
    const manager = new RootIdentityManager(tmp);

    // 英文 24 词中混入一个错词
    const words = bip39.generateMnemonic(256).split(' ');
    words[3] = 'notaword';
    await expect(manager.recoverFromMnemonic(words.join(' '), 'new-password-123')).rejects.toThrow(/校验失败/);

    // 中英混合无法通过任一词表校验
    const chinese = bip39.generateMnemonic(256, undefined, bip39.wordlists.chinese_simplified).split(' ');
    const mixed = [...chinese.slice(0, 12), ...bip39.generateMnemonic(256).split(' ').slice(0, 12)];
    await expect(manager.recoverFromMnemonic(mixed.join(' '), 'new-password-123')).rejects.toThrow(/校验失败/);

    await rm(tmp, { recursive: true, force: true });
  });

  it('recovers from encrypted backup payload (QR) with original password', async () => {
    const tmpA = await makeTmp();
    const tmpB = await makeTmp();

    const managerA = new RootIdentityManager(tmpA);
    const init = await managerA.initialize('backup-password-1');
    const { payload } = await managerA.getEncryptedBackupPayload();

    const managerB = new RootIdentityManager(tmpB);
    const recovered = await managerB.recoverFromBackup(payload, 'backup-password-1');
    expect(recovered.rootId).toBe(init.rootId);
    expect(() => managerB.sign('payload')).not.toThrow();

    await rm(tmpA, { recursive: true, force: true });
    await rm(tmpB, { recursive: true, force: true });
  });

  it('distinguishes wrong password, corrupted ciphertext and invalid payload on backup recovery', async () => {
    const tmpA = await makeTmp();

    const managerA = new RootIdentityManager(tmpA);
    await managerA.initialize('backup-password-1');
    const { payload } = await managerA.getEncryptedBackupPayload();

    const mkManager = async () => {
      const tmp = await makeTmp();
      return { tmp, manager: new RootIdentityManager(tmp) };
    };
    // 密码错误
    const wrongPw = await mkManager();
    await expect(wrongPw.manager.recoverFromBackup(payload, 'wrong-password-1')).rejects.toThrow(/密码不正确/);
    await rm(wrongPw.tmp, { recursive: true, force: true });

    // 密文被篡改（GCM tag 校验失败，同样按密码错误路径拒绝）
    const tampered = JSON.parse(payload);
    const ct: string = tampered.encryption.ciphertext;
    tampered.encryption.ciphertext = `${ct.slice(0, -4)}AAAA`;
    const tamperedCase = await mkManager();
    await expect(tamperedCase.manager.recoverFromBackup(JSON.stringify(tampered), 'backup-password-1')).rejects.toThrow(/密码不正确/);
    await rm(tamperedCase.tmp, { recursive: true, force: true });

    // 载荷结构无效
    const invalidCase = await mkManager();
    await expect(invalidCase.manager.recoverFromBackup('not-json{{{', 'backup-password-1')).rejects.toThrow(/无效|损坏/);
    await expect(invalidCase.manager.recoverFromBackup('{"foo":1}', 'backup-password-1')).rejects.toThrow(/无效|损坏/);
    await rm(invalidCase.tmp, { recursive: true, force: true });

    await rm(tmpA, { recursive: true, force: true });
  });
});

describe('助记词输入规范化', () => {
  it('splits spaced and continuous input into words', () => {
    expect(splitMnemonicInput('坦 职 霸 里')).toEqual(['坦', '职', '霸', '里']);
    expect(splitMnemonicInput('坦职霸里')).toEqual(['坦', '职', '霸', '里']);
    expect(splitMnemonicInput('  坦  职 \n 霸 里  ')).toEqual(['坦', '职', '霸', '里']);
    expect(splitMnemonicInput('')).toEqual([]);
  });

  it('flags words outside all recovery wordlists', () => {
    expect(findInvalidMnemonicWords(['的', '一', '是'])).toEqual([]);
    // 英文词表词同样视为有效（v1 英文助记词兼容）
    expect(findInvalidMnemonicWords(['abandon', '的'])).toEqual([]);
    expect(findInvalidMnemonicWords(['的', '龘', 'ab'])).toEqual([1, 2]);
  });
});
