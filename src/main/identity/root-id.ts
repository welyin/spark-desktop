import { app } from 'electron';
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, scryptSync } from 'crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

const IDENTITY_VERSION = 2;
// v1（legacy）：pbkdf2 + aes-256-cbc，仅保留用于读取旧身份文件/旧备份
const PASSWORD_KDF_ITERATIONS = 210_000;
const PASSWORD_KDF_DIGEST = 'sha512';
const PASSWORD_KDF_KEYLEN = 32;
// v2：scrypt（内存硬，提高离线爆破成本）+ aes-256-gcm（AEAD，可区分密码错误与数据损坏）
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DERIVATION_PATH = `m/44'/607'/0'/0'/0'`;
const BIP39_ENTROPY_BITS = 256; // 24 words per BIP39.
const BIP39_PASSPHRASE = 'Polykey';
// 助记词默认使用 BIP39 中文简体词表（每词单字，24 字）；词表是身份的一部分，
// 恢复时必须使用同一词表才能导出相同 seed/rootId
const BIP39_WORDLIST = bip39.wordlists.chinese_simplified;
const WORDLIST_NAME = 'chinese_simplified';
// 恢复时按序尝试的词表：中文优先生效；英文用于兼容 v1 时代生成的英文助记词
const RECOVERY_WORDLISTS: Array<{ name: string; words: string[] }> = [
  { name: WORDLIST_NAME, words: BIP39_WORDLIST },
  { name: 'english', words: bip39.wordlists.english }
];

type Slip10Node = {
  key: Buffer;
  chainCode: Buffer;
};

type EncryptedRootSecret = {
  mnemonic: string;
  derivationPath: string;
};

type KdfV1 = {
  salt: string;
  iterations: number;
  keyLen: number;
  digest: string;
};

type KdfV2 = {
  name: 'scrypt';
  salt: string;
  N: number;
  r: number;
  p: number;
  keyLen: number;
};

type EncryptionV1 = {
  iv: string;
  algorithm: 'aes-256-cbc';
  ciphertext: string;
};

type EncryptionV2 = {
  iv: string;
  tag: string;
  algorithm: 'aes-256-gcm';
  ciphertext: string;
};

type StoredRootIdentity = {
  version: number;
  rootId: string;
  publicKey: string;
  createdAt: number;
  /** v2 起记录助记词词表；v1 文件缺省为英文词表（仅派生用，不参与校验） */
  wordlist?: string;
  /** 用户昵称（明文展示信息，非密钥材料）；旧身份文件可能缺省 */
  nickname?: string;
  /** 用户上传头像（dataURL，明文展示信息）；缺省时 UI 按 rootId 生成自动头像 */
  avatar?: string;
  kdf: KdfV1 | KdfV2;
  encryption: EncryptionV1 | EncryptionV2;
};

type UnlockedRootIdentity = {
  rootId: string;
  publicKey: Buffer;
  privateKey: Buffer;
  signingSecretKey: Uint8Array;
  seed: Buffer;
  derivationPath: string;
};

export type RootIdentityStatus = {
  initialized: boolean;
  unlocked: boolean;
  rootId: string | null;
  /** 当前活跃身份昵称；未设置（旧身份）为 null */
  nickname: string | null;
  /** 当前活跃身份头像 dataURL；未设置为 null（UI 应回退自动头像） */
  avatar: string | null;
};

export type RootSignature = {
  rootId: string;
  signature: string;
  payloadHash: string;
};

export type DerivedDomainIdentity = {
  domain: string;
  domainId: string;
  publicKey: string;
  derivationPath: string;
};

export type DomainSignature = {
  domain: string;
  domainId: string;
  publicKey: string;
  signature: string;
  payloadHash: string;
};

function parsePath(pathValue: string): number[] {
  if (!pathValue.startsWith('m/')) {
    throw new Error(`Invalid derivation path: ${pathValue}`);
  }
  return pathValue
    .slice(2)
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (!segment.endsWith("'")) {
        throw new Error(`Ed25519 SLIP-0010 only supports hardened segments: ${segment}`);
      }
      const value = Number.parseInt(segment.slice(0, -1), 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid path segment: ${segment}`);
      }
      return value;
    });
}

function deriveSlip10Master(seed: Buffer): Slip10Node {
  const digest = createHmac('sha512', Buffer.from('ed25519 seed', 'utf8')).update(seed).digest();
  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32)
  };
}

function deriveSlip10Child(parent: Slip10Node, index: number): Slip10Node {
  const hardened = index + 0x80000000;
  const data = Buffer.alloc(1 + 32 + 4);
  data[0] = 0;
  parent.key.copy(data, 1);
  data.writeUInt32BE(hardened >>> 0, 33);
  const digest = createHmac('sha512', parent.chainCode).update(data).digest();
  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32)
  };
}

function deriveSlip10Path(seed: Buffer, derivationPath: string): Slip10Node {
  let node = deriveSlip10Master(seed);
  const indexes = parsePath(derivationPath);
  for (const index of indexes) {
    node = deriveSlip10Child(node, index);
  }
  return node;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 校验 Ed25519 分离签名（纯函数，无需解锁身份，供任意验签方使用）
 */
export function verifyEd25519Signature(payload: string | Buffer, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const signature = Buffer.from(signatureBase64, 'base64');
    const publicKey = Buffer.from(publicKeyBase64, 'base64');
    if (publicKey.length !== nacl.sign.publicKeyLength || signature.length !== nacl.sign.signatureLength) {
      return false;
    }
    return nacl.sign.detached.verify(new Uint8Array(bytes), new Uint8Array(signature), new Uint8Array(publicKey));
  } catch {
    return false;
  }
}

function derivePasswordKey(password: string, kdf: KdfV1 | KdfV2): Buffer {
  const salt = Buffer.from(kdf.salt, 'base64');
  if ((kdf as KdfV2).name === 'scrypt') {
    const v2 = kdf as KdfV2;
    return scryptSync(password, salt, v2.keyLen, { N: v2.N, r: v2.r, p: v2.p, maxmem: SCRYPT_MAXMEM });
  }
  const v1 = kdf as KdfV1;
  return pbkdf2Sync(password, salt, v1.iterations, v1.keyLen, v1.digest);
}

function encryptRootSecret(password: string, secret: EncryptedRootSecret): Pick<StoredRootIdentity, 'kdf' | 'encryption'> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLen: SCRYPT_KEYLEN
    },
    encryption: {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      algorithm: 'aes-256-gcm',
      ciphertext: ciphertext.toString('base64')
    }
  };
}

function decryptRootSecret(password: string, payload: StoredRootIdentity): EncryptedRootSecret {
  const key = derivePasswordKey(password, payload.kdf);
  const iv = Buffer.from(payload.encryption.iv, 'base64');
  const ciphertext = Buffer.from(payload.encryption.ciphertext, 'base64');

  let plaintext: Buffer;
  if (payload.encryption.algorithm === 'aes-256-gcm') {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from((payload.encryption as EncryptionV2).tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } else {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  return JSON.parse(plaintext.toString('utf8')) as EncryptedRootSecret;
}

/**
 * 规范化助记词输入为词数组：中文词表每词单字，
 * 同时接受"空格分隔"与"连续书写"两种录入形式
 */
export function splitMnemonicInput(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }
  if (/\s/.test(trimmed)) {
    return trimmed.split(/\s+/).filter(Boolean);
  }
  return [...trimmed];
}

/** 逐词对照全部可恢复词表（中文简体 + 英文），返回不在任何词表中的词下标（供 UI 高亮错字） */
export function findInvalidMnemonicWords(words: string[]): number[] {
  const invalid: number[] = [];
  words.forEach((word, index) => {
    if (!RECOVERY_WORDLISTS.some((wordlist) => wordlist.words.includes(word))) {
      invalid.push(index);
    }
  });
  return invalid;
}

/** 依次用各词表校验助记词（含 BIP39 checksum），返回通过校验的词表名；全部失败返回 null */
function detectMnemonicWordlist(mnemonic: string): string | null {
  for (const wordlist of RECOVERY_WORDLISTS) {
    if (bip39.validateMnemonic(mnemonic, wordlist.words)) {
      return wordlist.name;
    }
  }
  return null;
}

function createKeypairFromMnemonic(mnemonic: string, derivationPath: string): UnlockedRootIdentity {
  const seed = bip39.mnemonicToSeedSync(mnemonic, BIP39_PASSPHRASE);
  const slipNode = deriveSlip10Path(seed, derivationPath);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(slipNode.key));
  const publicKey = Buffer.from(keypair.publicKey);
  const privateKey = Buffer.from(keypair.secretKey.subarray(0, 32));
  const rootId = sha256Hex(publicKey);

  return {
    rootId,
    publicKey,
    privateKey,
    signingSecretKey: keypair.secretKey,
    seed,
    derivationPath
  };
}

export type IdentitySummary = {
  rootId: string;
  createdAt: number;
  active: boolean;
  /** 昵称与头像（dataURL）；旧身份文件缺省为 null，UI 回退自动头像与"未命名用户" */
  nickname: string | null;
  avatar: string | null;
};

const NICKNAME_MAX_LEN = 24;
const AVATAR_DATA_URL_MAX_LEN = 200_000; // 头像 dataURL 体积上限（约 150KB 图片）

/** 昵称规范化：去首尾空白；required 时为空直接抛错 */
function normalizeNickname(nickname: string | null | undefined, required: boolean): string | undefined {
  const trimmed = (nickname ?? '').trim();
  if (!trimmed) {
    if (required) {
      throw new Error('昵称不能为空');
    }
    return undefined;
  }
  if ([...trimmed].length > NICKNAME_MAX_LEN) {
    throw new Error(`昵称最长 ${NICKNAME_MAX_LEN} 个字符`);
  }
  return trimmed;
}

/** 头像规范化：必须为 data:image/ 开头且体积受限；空值返回 undefined（回退自动头像） */
function normalizeAvatar(avatar: string | null | undefined): string | undefined {
  if (!avatar) {
    return undefined;
  }
  if (!avatar.startsWith('data:image/')) {
    throw new Error('头像必须是图片');
  }
  if (avatar.length > AVATAR_DATA_URL_MAX_LEN) {
    throw new Error('头像图片过大，请选择更小的图片');
  }
  return avatar;
}

/** 备份恢复等外部来源的身份资料清洗：昵称/头像是展示信息，非法时静默剔除而非阻断恢复 */
function sanitizeExternalProfile(payload: StoredRootIdentity): void {
  try {
    payload.nickname = normalizeNickname(payload.nickname, false);
  } catch {
    delete payload.nickname;
  }
  try {
    payload.avatar = normalizeAvatar(payload.avatar);
  } catch {
    delete payload.avatar;
  }
  if (payload.nickname === undefined) {
    delete payload.nickname;
  }
  if (payload.avatar === undefined) {
    delete payload.avatar;
  }
}

export class RootIdentityManager {
  private readonly baseDir: string;
  private readonly identitiesDir: string;
  private readonly activeFilePath: string;
  private readonly legacyFilePath: string;
  private migratePromise: Promise<void> | null = null;

  private unlockedIdentity: UnlockedRootIdentity | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? this.resolveDefaultBaseDir();
    this.identitiesDir = path.join(this.baseDir, 'identities');
    this.activeFilePath = path.join(this.baseDir, 'active-identity.json');
    this.legacyFilePath = path.join(this.baseDir, 'root-identity.json');
  }

  private resolveDefaultBaseDir(): string {
    try {
      if (app && typeof app.getPath === 'function') {
        return app.getPath('userData');
      }
    } catch {
      // Ignore and fallback for non-electron runtime (e.g. unit tests).
    }
    return process.cwd();
  }

  private identityFilePath(rootId: string): string {
    return path.join(this.identitiesDir, `${rootId}.json`);
  }

  /**
   * 旧版单身份文件迁移：root-identity.json → identities/<rootId>.json 并设为活跃。
   * 幂等，首次访问身份状态时执行一次
   */
  private async migrateLegacyIfNeeded(): Promise<void> {
    if (!this.migratePromise) {
      this.migratePromise = (async () => {
        let legacyRaw: string;
        try {
          legacyRaw = await readFile(this.legacyFilePath, 'utf8');
        } catch {
          return; // 无旧文件
        }
        try {
          const legacy = JSON.parse(legacyRaw) as StoredRootIdentity;
          if (!legacy || typeof legacy.rootId !== 'string') {
            return;
          }
          await mkdir(this.identitiesDir, { recursive: true });
          if (!(await this.readIdentityFile(legacy.rootId))) {
            await writeFile(this.identityFilePath(legacy.rootId), legacyRaw, 'utf8');
          }
          await unlink(this.legacyFilePath);
          if (!(await this.readActiveRootId())) {
            await this.writeActiveRootId(legacy.rootId);
          }
          console.log('[identity] migrated legacy root-identity.json into identities/');
        } catch (error) {
          console.warn('[identity] legacy identity migration failed', error);
        }
      })();
    }
    await this.migratePromise;
  }

  private async readActiveRootId(): Promise<string | null> {
    try {
      const raw = await readFile(this.activeFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { activeRootId?: unknown };
      return typeof parsed.activeRootId === 'string' ? parsed.activeRootId : null;
    } catch {
      return null;
    }
  }

  private async writeActiveRootId(rootId: string): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.activeFilePath, JSON.stringify({ activeRootId: rootId }), 'utf8');
  }

  private async readIdentityFile(rootId: string): Promise<StoredRootIdentity | null> {
    try {
      const raw = await readFile(this.identityFilePath(rootId), 'utf8');
      return JSON.parse(raw) as StoredRootIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /** 当前活跃身份 rootId（解锁中的优先，其次 active 指针）；无任何身份时为 null */
  async getActiveRootId(): Promise<string | null> {
    if (this.unlockedIdentity) {
      return this.unlockedIdentity.rootId;
    }
    await this.migrateLegacyIfNeeded();
    return this.readActiveRootId();
  }

  /** 本设备已知的全部身份（切换用户列表），按创建时间升序 */
  async listIdentities(): Promise<IdentitySummary[]> {
    await this.migrateLegacyIfNeeded();
    const activeRootId = await this.readActiveRootId();
    let files: string[];
    try {
      files = await readdir(this.identitiesDir);
    } catch {
      return [];
    }
    const result: IdentitySummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const payload = JSON.parse(await readFile(path.join(this.identitiesDir, file), 'utf8')) as StoredRootIdentity;
        // 文件名与内容 rootId 必须一致，否则视为损坏文件跳过（避免列出无法解锁的身份）
        if (typeof payload.rootId !== 'string' || file !== `${payload.rootId}.json`) {
          continue;
        }
        result.push({
          rootId: payload.rootId,
          createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : 0,
          active: payload.rootId === activeRootId,
          nickname: typeof payload.nickname === 'string' && payload.nickname.trim() ? payload.nickname : null,
          avatar: typeof payload.avatar === 'string' && payload.avatar.startsWith('data:image/') ? payload.avatar : null
        });
      } catch {
        // 跳过损坏的身份文件
      }
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 切换登录目标用户（只改 active 指针不解锁；数据存储随解锁成功时切换） */
  async setActiveIdentity(rootId: string): Promise<void> {
    await this.migrateLegacyIfNeeded();
    if (!(await this.readIdentityFile(rootId))) {
      throw new Error('该账号不在本设备上');
    }
    await this.writeActiveRootId(rootId);
  }

  async getStatus(): Promise<RootIdentityStatus> {
    const identities = await this.listIdentities();
    const rootId = this.unlockedIdentity?.rootId ?? (await this.readActiveRootId());
    const current = rootId ? identities.find((item) => item.rootId === rootId) : undefined;
    return {
      initialized: identities.length > 0,
      unlocked: !!this.unlockedIdentity,
      rootId,
      nickname: current?.nickname ?? null,
      avatar: current?.avatar ?? null
    };
  }

  async initialize(password: string, nickname: string, avatar?: string | null): Promise<{ rootId: string; mnemonic: string }> {
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const normalizedNickname = normalizeNickname(nickname, true) as string;
    const normalizedAvatar = normalizeAvatar(avatar);

    const mnemonic = bip39.generateMnemonic(BIP39_ENTROPY_BITS, undefined, BIP39_WORDLIST);
    const unlocked = createKeypairFromMnemonic(mnemonic, DERIVATION_PATH);
    const encrypted = encryptRootSecret(password, {
      mnemonic,
      derivationPath: DERIVATION_PATH
    });

    const payload: StoredRootIdentity = {
      version: IDENTITY_VERSION,
      rootId: unlocked.rootId,
      publicKey: unlocked.publicKey.toString('base64'),
      createdAt: Date.now(),
      wordlist: WORDLIST_NAME,
      nickname: normalizedNickname,
      ...(normalizedAvatar ? { avatar: normalizedAvatar } : {}),
      ...encrypted
    };

    await this.writeStoredIdentity(payload);
    await this.writeActiveRootId(unlocked.rootId);
    this.unlockedIdentity = unlocked;
    return { rootId: unlocked.rootId, mnemonic };
  }

  async unlock(password: string, rootId?: string): Promise<{ rootId: string }> {
    await this.migrateLegacyIfNeeded();
    const target = rootId ?? (await this.readActiveRootId());
    if (!target) {
      throw new Error('Root identity is not initialized');
    }
    const payload = await this.readIdentityFile(target);
    if (!payload) {
      throw new Error('该账号不在本设备上');
    }

    let secret: EncryptedRootSecret;
    try {
      secret = decryptRootSecret(password, payload);
    } catch {
      throw new Error('Invalid password');
    }

    const unlocked = createKeypairFromMnemonic(secret.mnemonic, secret.derivationPath);
    if (unlocked.rootId !== payload.rootId) {
      throw new Error('Root identity verification failed');
    }
    await this.writeActiveRootId(unlocked.rootId);
    this.unlockedIdentity = unlocked;
    return { rootId: unlocked.rootId };
  }

  lock(): void {
    this.unlockedIdentity = null;
  }

  /** 密码门控的助记词再次查看（逃生舱）：解密当前活跃身份文件返回助记词 */
  async revealMnemonic(password: string): Promise<{ mnemonic: string }> {
    const target = await this.getActiveRootId();
    const payload = target ? await this.readIdentityFile(target) : null;
    if (!payload) {
      throw new Error('Root identity is not initialized');
    }
    let secret: EncryptedRootSecret;
    try {
      secret = decryptRootSecret(password, payload);
    } catch {
      throw new Error('Invalid password');
    }
    return { mnemonic: secret.mnemonic };
  }

  /**
   * 导出加密备份载荷（备份二维码内容）：即当前活跃身份密文记录的紧凑 JSON。
   * 密文本身不敏感，可经相册/网络传输；恢复时必须配合原登录密码。
   */
  async getEncryptedBackupPayload(): Promise<{ payload: string }> {
    const target = await this.getActiveRootId();
    const payload = target ? await this.readIdentityFile(target) : null;
    if (!payload) {
      throw new Error('Root identity is not initialized');
    }
    return { payload: JSON.stringify(payload) };
  }

  /**
   * 助记词恢复：助记词是最高权限（无需旧密码），恢复后以 newPassword 重新加密存储。
   * 依次尝试中文简体与英文词表（含 BIP39 checksum）——英文用于兼容 v1 时代
   * 生成的助记词；通过校验的词表名记入身份文件。
   */
  async recoverFromMnemonic(mnemonicInput: string, newPassword: string, nickname: string, avatar?: string | null): Promise<{ rootId: string }> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const normalizedNickname = normalizeNickname(nickname, true) as string;
    const normalizedAvatar = normalizeAvatar(avatar);
    await this.migrateLegacyIfNeeded();

    const words = splitMnemonicInput(mnemonicInput);
    const mnemonic = words.join(' ');
    const wordlistName = words.length === 24 ? detectMnemonicWordlist(mnemonic) : null;
    if (!wordlistName) {
      throw new Error('助记词校验失败：请检查是否有错别字、漏字或顺序错误');
    }

    const unlocked = createKeypairFromMnemonic(mnemonic, DERIVATION_PATH);
    if (await this.readIdentityFile(unlocked.rootId)) {
      throw new Error('该账号已在本设备上，请直接登录');
    }

    const encrypted = encryptRootSecret(newPassword, {
      mnemonic,
      derivationPath: DERIVATION_PATH
    });
    const payload: StoredRootIdentity = {
      version: IDENTITY_VERSION,
      rootId: unlocked.rootId,
      publicKey: unlocked.publicKey.toString('base64'),
      createdAt: Date.now(),
      wordlist: wordlistName,
      nickname: normalizedNickname,
      ...(normalizedAvatar ? { avatar: normalizedAvatar } : {}),
      ...encrypted
    };

    await this.writeStoredIdentity(payload);
    await this.writeActiveRootId(unlocked.rootId);
    this.unlockedIdentity = unlocked;
    return { rootId: unlocked.rootId };
  }

  /**
   * 加密备份（二维码）恢复：载荷即身份密文记录，解密口令为原登录密码。
   * 结构无效与密码错误分别报错（GCM tag 校验失败即密码错误）。
   */
  async recoverFromBackup(payloadJson: string, password: string): Promise<{ rootId: string }> {
    await this.migrateLegacyIfNeeded();

    let payload: StoredRootIdentity;
    try {
      payload = JSON.parse(payloadJson) as StoredRootIdentity;
      if (!payload || typeof payload.rootId !== 'string' || !payload.kdf || !payload.encryption) {
        throw new Error('bad shape');
      }
    } catch {
      throw new Error('备份数据无效或已损坏');
    }

    let secret: EncryptedRootSecret;
    try {
      secret = decryptRootSecret(password, payload);
    } catch {
      throw new Error('密码不正确');
    }

    const unlocked = createKeypairFromMnemonic(secret.mnemonic, secret.derivationPath);
    if (unlocked.rootId !== payload.rootId) {
      throw new Error('备份数据校验失败：rootId 不匹配');
    }
    if (await this.readIdentityFile(unlocked.rootId)) {
      throw new Error('该账号已在本设备上，请直接登录');
    }

    // 备份载荷即身份记录本身，昵称/头像随备份自然携带（旧备份可能缺省，清洗后落库）
    sanitizeExternalProfile(payload);
    await this.writeStoredIdentity(payload);
    await this.writeActiveRootId(unlocked.rootId);
    this.unlockedIdentity = unlocked;
    return { rootId: unlocked.rootId };
  }

  /** 更新当前已解锁身份的资料（昵称/头像）；avatar 传 null 表示恢复自动头像 */
  async updateProfile(profile: { nickname?: string | null; avatar?: string | null }): Promise<{ nickname: string | null; avatar: string | null }> {
    const unlocked = this.requireUnlocked();
    const payload = await this.readIdentityFile(unlocked.rootId);
    if (!payload) {
      throw new Error('Root identity is not initialized');
    }

    if (profile.nickname !== undefined && profile.nickname !== null) {
      payload.nickname = normalizeNickname(profile.nickname, true);
    }
    if (profile.avatar !== undefined) {
      const normalized = normalizeAvatar(profile.avatar);
      if (normalized) {
        payload.avatar = normalized;
      } else {
        delete payload.avatar;
      }
    }

    await this.writeStoredIdentity(payload);
    return { nickname: payload.nickname ?? null, avatar: payload.avatar ?? null };
  }

  sign(payload: string | Buffer): RootSignature {
    const unlocked = this.requireUnlocked();
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const signature = nacl.sign.detached(new Uint8Array(bytes), unlocked.signingSecretKey);

    return {
      rootId: unlocked.rootId,
      signature: Buffer.from(signature).toString('base64'),
      payloadHash: sha256Hex(bytes)
    };
  }

  /** 当前已解锁身份的根公钥（base64）；锁定时返回 null。用于构造需携带公钥的签名载荷（如 nodeInfoClaim）。 */
  getUnlockedPublicKeyBase64(): string | null {
    return this.unlockedIdentity ? this.unlockedIdentity.publicKey.toString('base64') : null;
  }

  /**
   * 使用根身份私钥签名并附带回执公钥。
   * 与 sign() 的区别是返回公钥：校验方可用 sha256(publicKey) === rootId 自包含地
   * 验证签名者身份（用于 nodeInfoClaim 这类需要绑定 rootId ↔ 公钥的场景）。
   */
  signWithRootIdentity(payload: string | Buffer): { rootId: string; publicKey: string; signature: string } {
    const unlocked = this.requireUnlocked();
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const signature = nacl.sign.detached(new Uint8Array(bytes), unlocked.signingSecretKey);

    return {
      rootId: unlocked.rootId,
      publicKey: unlocked.publicKey.toString('base64'),
      signature: Buffer.from(signature).toString('base64')
    };
  }

  deriveDomainIdentity(domain: string): DerivedDomainIdentity {
    const { keypair, derivationPath } = this.deriveDomainKeypair(domain);
    const domainPublicKey = Buffer.from(keypair.publicKey);

    return {
      domain,
      domainId: sha256Hex(domainPublicKey),
      publicKey: domainPublicKey.toString('base64'),
      derivationPath
    };
  }

  /**
   * 使用域身份私钥对数据签名
   *
   * 安全说明：域密钥由根种子即时派生，仅存在于本方法调用栈内，
   * 不持久化、不返回给调用方；调用方只能拿到签名与公钥。
   */
  signWithDomainIdentity(domain: string, payload: string | Buffer): DomainSignature {
    const { keypair } = this.deriveDomainKeypair(domain);
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const signature = nacl.sign.detached(new Uint8Array(bytes), keypair.secretKey);
    const publicKey = Buffer.from(keypair.publicKey);

    return {
      domain,
      domainId: sha256Hex(publicKey),
      publicKey: publicKey.toString('base64'),
      signature: Buffer.from(signature).toString('base64'),
      payloadHash: sha256Hex(bytes)
    };
  }

  private deriveDomainKeypair(domain: string): { keypair: nacl.SignKeyPair; derivationPath: string } {
    const unlocked = this.requireUnlocked();
    if (!domain || domain.trim().length === 0) {
      throw new Error('Domain is required');
    }

    const digest = createHash('sha256').update(domain, 'utf8').digest();
    const idxA = digest.readUInt32BE(0) & 0x7fffffff;
    const idxB = digest.readUInt32BE(4) & 0x7fffffff;
    const derivationPath = `${unlocked.derivationPath}/${idxA}'/${idxB}'`;
    const domainNode = deriveSlip10Path(unlocked.seed, derivationPath);
    const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(domainNode.key));

    return { keypair, derivationPath };
  }

  private async writeStoredIdentity(payload: StoredRootIdentity): Promise<void> {
    await mkdir(this.identitiesDir, { recursive: true });
    await writeFile(this.identityFilePath(payload.rootId), JSON.stringify(payload, null, 2), 'utf8');
  }

  private requireUnlocked(): UnlockedRootIdentity {
    if (!this.unlockedIdentity) {
      throw new Error('Root identity is locked');
    }
    return this.unlockedIdentity;
  }
}

export const rootIdentityManager = new RootIdentityManager();