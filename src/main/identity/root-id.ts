import { app } from 'electron';
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

const IDENTITY_VERSION = 1;
const PASSWORD_KDF_ITERATIONS = 210_000;
const PASSWORD_KDF_DIGEST = 'sha512';
const PASSWORD_KDF_KEYLEN = 32;
const DERIVATION_PATH = `m/44'/607'/0'/0'/0'`;
const BIP39_ENTROPY_BITS = 256; // 24 words per BIP39.
const BIP39_PASSPHRASE = 'Polykey';

type Slip10Node = {
  key: Buffer;
  chainCode: Buffer;
};

type EncryptedRootSecret = {
  mnemonic: string;
  derivationPath: string;
};

type StoredRootIdentity = {
  version: number;
  rootId: string;
  publicKey: string;
  createdAt: number;
  kdf: {
    salt: string;
    iterations: number;
    keyLen: number;
    digest: string;
  };
  encryption: {
    iv: string;
    algorithm: 'aes-256-cbc';
    ciphertext: string;
  };
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

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function encryptRootSecret(password: string, secret: EncryptedRootSecret): Pick<StoredRootIdentity, 'kdf' | 'encryption'> {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(password, salt, PASSWORD_KDF_ITERATIONS, PASSWORD_KDF_KEYLEN, PASSWORD_KDF_DIGEST);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    kdf: {
      salt: salt.toString('base64'),
      iterations: PASSWORD_KDF_ITERATIONS,
      keyLen: PASSWORD_KDF_KEYLEN,
      digest: PASSWORD_KDF_DIGEST
    },
    encryption: {
      iv: iv.toString('base64'),
      algorithm: 'aes-256-cbc',
      ciphertext: ciphertext.toString('base64')
    }
  };
}

function decryptRootSecret(password: string, payload: StoredRootIdentity): EncryptedRootSecret {
  const salt = Buffer.from(payload.kdf.salt, 'base64');
  const iv = Buffer.from(payload.encryption.iv, 'base64');
  const ciphertext = Buffer.from(payload.encryption.ciphertext, 'base64');
  const key = pbkdf2Sync(password, salt, payload.kdf.iterations, payload.kdf.keyLen, payload.kdf.digest);

  const decipher = createDecipheriv(payload.encryption.algorithm, key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as EncryptedRootSecret;
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

export class RootIdentityManager {
  private readonly storageFilePath: string;

  private unlockedIdentity: UnlockedRootIdentity | null = null;

  constructor(storageFilePath?: string) {
    this.storageFilePath = storageFilePath ?? this.resolveDefaultStoragePath();
  }

  private resolveDefaultStoragePath(): string {
    try {
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'root-identity.json');
      }
    } catch {
      // Ignore and fallback for non-electron runtime (e.g. unit tests).
    }
    return path.join(process.cwd(), '.spark-root-identity.json');
  }

  async getStatus(): Promise<RootIdentityStatus> {
    const payload = await this.readStoredIdentity();
    return {
      initialized: !!payload,
      unlocked: !!this.unlockedIdentity,
      rootId: payload?.rootId ?? this.unlockedIdentity?.rootId ?? null
    };
  }

  async initialize(password: string): Promise<{ rootId: string; mnemonic: string }> {
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const existing = await this.readStoredIdentity();
    if (existing) {
      throw new Error('Root identity already exists on this device');
    }

    const mnemonic = bip39.generateMnemonic(BIP39_ENTROPY_BITS);
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
      ...encrypted
    };

    await this.writeStoredIdentity(payload);
    this.unlockedIdentity = unlocked;
    return { rootId: unlocked.rootId, mnemonic };
  }

  async unlock(password: string): Promise<{ rootId: string }> {
    const payload = await this.readStoredIdentity();
    if (!payload) {
      throw new Error('Root identity is not initialized');
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
    this.unlockedIdentity = unlocked;
    return { rootId: unlocked.rootId };
  }

  lock(): void {
    this.unlockedIdentity = null;
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

  deriveDomainIdentity(domain: string): DerivedDomainIdentity {
    const unlocked = this.requireUnlocked();
    if (!domain || domain.trim().length === 0) {
      throw new Error('Domain is required');
    }

    const digest = createHash('sha256').update(domain, 'utf8').digest();
    const idxA = digest.readUInt32BE(0) & 0x7fffffff;
    const idxB = digest.readUInt32BE(4) & 0x7fffffff;
    const domainPath = `${unlocked.derivationPath}/${idxA}'/${idxB}'`;
    const domainNode = deriveSlip10Path(unlocked.seed, domainPath);
    const domainKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(domainNode.key));
    const domainPublicKey = Buffer.from(domainKeypair.publicKey);

    return {
      domain,
      domainId: sha256Hex(domainPublicKey),
      publicKey: domainPublicKey.toString('base64'),
      derivationPath: domainPath
    };
  }

  private async readStoredIdentity(): Promise<StoredRootIdentity | null> {
    try {
      const raw = await readFile(this.storageFilePath, 'utf8');
      return JSON.parse(raw) as StoredRootIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async writeStoredIdentity(payload: StoredRootIdentity): Promise<void> {
    await mkdir(path.dirname(this.storageFilePath), { recursive: true });
    await writeFile(this.storageFilePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private requireUnlocked(): UnlockedRootIdentity {
    if (!this.unlockedIdentity) {
      throw new Error('Root identity is locked');
    }
    return this.unlockedIdentity;
  }
}

export const rootIdentityManager = new RootIdentityManager();