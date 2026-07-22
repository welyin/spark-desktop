/**
 * Golden vector 提取脚本（Rust 内核重写阶段①）：
 * 从 TS 实现反向提取验收向量，写入 code/spec/vectors/{identity,sync-evidence}.json，
 * 供 Rust 侧逐字节对齐验收。两份规格的向量清单：
 *   - code/spec/identity.md §7
 *   - code/spec/sync-evidence.md §5
 *
 * 运行方式（在 desktop/ 目录下）：
 *   npm run vectors:extract
 * 等价于：
 *   esbuild scripts/extract-vectors.mts --bundle --platform=node --format=esm \
 *     --packages=external --alias:electron=./scripts/electron-stub.mjs \
 *     --outfile=node_modules/.cache/extract-vectors.mjs && node node_modules/.cache/extract-vectors.mjs
 *
 * 确定性：所有随机值（mnemonic / salt / iv / timestamp）均为下方硬编码常量，
 * 重复运行产出字节级一致的 JSON（输出不含任何 wall-clock 时间）。
 *
 * 实现耦合说明（root-id.ts / evidence.ts 的部分原语是模块私有函数）：
 * - createKeypairFromMnemonic / deriveSlip10Path / encryptRootSecret / decryptRootSecret 未导出。
 *   本脚本通过 RootIdentityManager 公共 API + 临时目录跑真实完整流程（recover / initialize /
 *   unlock / deriveDomainIdentity）拿到真实输出；对必须固定 salt/iv 的加解密向量，
 *   在脚本内按 root-id.ts 的同款参数复刻 node:crypto 调用，并用真实代码交叉验证：
 *     v2：真实 initialize() 落盘的身份文件，用复刻的 decrypt 解出原文 → 证明复刻 === 实现；
 *     v1：复刻的 v1 密文构造身份文件，真实 unlock() 成功解锁 → 证明实现能解复刻输出。
 * - normalizeObject / mergeVersionVectors 未导出：脚本内逐行复刻，
 *   normalizeObject 的每个用例都用真实导出的 buildEvidencePayloadHash 做 sha256 交叉校验。
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, scryptSync } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

import { RootIdentityManager, sha256Hex } from '../src/main/identity/root-id.js';
import {
  appendEvidence,
  buildEvidenceDataHash,
  buildEvidenceEntryHash,
  buildEvidenceMetaHash,
  buildEvidencePayloadHash,
  evidenceKey,
  verifyEvidenceChain
} from '../src/main/db/evidence.js';
import { compareVersionVectors, resolveConflictByLWW } from '../src/main/db/sync.js';
import { collectionSchemaKey, DEFAULT_COLLECTION_POLICY, resolveSchemaDeclaration } from '../src/main/db/schema.js';

// ---------------------------------------------------------------------------
// 固定常量（保证可重复）
// ---------------------------------------------------------------------------

/** 固定中文 24 词 mnemonic（真实 bip39.generateMnemonic(256, _, chinese_simplified) 生成后硬编码；测试向量，非真实身份） */
const MNEMONIC_ZH = '与 祝 产 鸡 永 烂 施 师 蓝 荷 有 邓 朗 防 管 李 原 芳 饿 万 措 走 腰 旅';
/** 固定英文 24 词 mnemonic（v1 遗产词表，真实生成后硬编码） */
const MNEMONIC_EN = 'wage secret force quantum hurt village fire success duck leader virus off flip possible ethics muscle actual cannon ritual express often wall excess room';

const BIP39_PASSPHRASE = 'Polykey';
const DERIVATION_PATH = `m/44'/607'/0'/0'/0'`;

const V2_PASSWORD = 'Vec0-Passw0rd!';
const V2_SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex'); // 16B
const V2_IV = Buffer.from('0102030405060708090a0b0c', 'hex'); // 12B (GCM)

const V1_PASSWORD = 'Vec0-Passw0rd!';
const V1_SALT = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'); // 16B
const V1_IV = Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex'); // 16B (CBC)

// KDF 参数与 root-id.ts 保持一致（脚本内断言真实文件里的参数等于这些值）
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 };
const PBKDF2_PARAMS = { iterations: 210000, digest: 'sha512', keyLen: 32 };

// 注意：脚本经 esbuild 打包到 node_modules/.cache 下运行，import.meta.url 不可靠；
// npm run vectors:extract 约定从 desktop/ 目录执行，故用 cwd 定位仓库根的 code/spec/vectors
const vectorsDir = path.resolve(process.cwd(), '../code/spec/vectors');

const tmpDirs: string[] = [];
let checkCount = 0;

function assert(condition: unknown, message: string): void {
  checkCount += 1;
  if (!condition) {
    throw new Error(`[extract-vectors] check failed: ${message}`);
  }
}

function makeTmpDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `spark-vectors-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 复刻原语（与 src 逐行对应；均经真实实现交叉验证，见下）
// ---------------------------------------------------------------------------

// --- root-id.ts: SLIP-0010 ---
type Slip10Node = { key: Buffer; chainCode: Buffer };

function deriveSlip10Master(seed: Buffer): Slip10Node {
  const digest = createHmac('sha512', Buffer.from('ed25519 seed', 'utf8')).update(seed).digest();
  return { key: digest.subarray(0, 32), chainCode: digest.subarray(32) };
}

function deriveSlip10Child(parent: Slip10Node, index: number): Slip10Node {
  const hardened = index + 0x80000000;
  const data = Buffer.alloc(1 + 32 + 4);
  data[0] = 0;
  parent.key.copy(data, 1);
  data.writeUInt32BE(hardened >>> 0, 33);
  const digest = createHmac('sha512', parent.chainCode).update(data).digest();
  return { key: digest.subarray(0, 32), chainCode: digest.subarray(32) };
}

function parsePath(pathValue: string): number[] {
  return pathValue
    .slice(2)
    .split('/')
    .filter(Boolean)
    .map((segment) => Number.parseInt(segment.slice(0, -1), 10));
}

function deriveSlip10Path(seed: Buffer, derivationPath: string): Slip10Node {
  let node = deriveSlip10Master(seed);
  for (const index of parsePath(derivationPath)) {
    node = deriveSlip10Child(node, index);
  }
  return node;
}

// --- root-id.ts: v2 scrypt + aes-256-gcm ---
function v2Encrypt(password: string, plaintext: string, salt: Buffer, iv: Buffer) {
  const key = scryptSync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, authTag: cipher.getAuthTag() };
}

function v2Decrypt(password: string, salt: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer): string {
  const key = scryptSync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem
  });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// --- root-id.ts: v1 pbkdf2 + aes-256-cbc ---
function v1Encrypt(password: string, plaintext: string, salt: Buffer, iv: Buffer) {
  const key = pbkdf2Sync(password, salt, PBKDF2_PARAMS.iterations, PBKDF2_PARAMS.keyLen, PBKDF2_PARAMS.digest);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
}

function v1Decrypt(password: string, salt: Buffer, iv: Buffer, ciphertext: Buffer): string {
  const key = pbkdf2Sync(password, salt, PBKDF2_PARAMS.iterations, PBKDF2_PARAMS.keyLen, PBKDF2_PARAMS.digest);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// --- evidence.ts: normalizeObject（逐行复刻；每个用例经真实 hash 函数交叉校验） ---
function normalizeObject(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  const ordered: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = normalizeObject((value as Record<string, any>)[key]);
  }
  return JSON.stringify(ordered);
}

// --- sync.ts: mergeVersionVectors（模块私有，逐行复刻；无导出可交叉校验，输出已标注 replicated） ---
function mergeVersionVectors(
  local: Record<string, number> | null,
  remote: Record<string, number> | null
): Record<string, number> {
  const merged: Record<string, number> = { ...(remote ?? {}) };
  for (const [nodeId, counter] of Object.entries(local ?? {})) {
    merged[nodeId] = Math.max(merged[nodeId] ?? 0, counter);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// identity.json
// ---------------------------------------------------------------------------

function publicKeyHexFromBase64(publicKeyBase64: string): string {
  return Buffer.from(publicKeyBase64, 'base64').toString('hex');
}

async function extractIdentityVectors() {
  // --- 1. 中文 mnemonic → 真实 recover 流程（含词表探测 + SLIP-0010 + 落盘） ---
  const dirZh = makeTmpDir('zh');
  const managerZh = new RootIdentityManager(dirZh);
  const { rootId: rootIdZh } = await managerZh.recoverFromMnemonic(MNEMONIC_ZH, V2_PASSWORD, '向量用户');
  const publicKeyBase64Zh = managerZh.getUnlockedPublicKeyBase64()!;
  const publicKeyHexZh = publicKeyHexFromBase64(publicKeyBase64Zh);
  const storedZh = JSON.parse(readFileSync(path.join(dirZh, 'identities', `${rootIdZh}.json`), 'utf8'));
  assert(storedZh.wordlist === 'chinese_simplified', 'zh mnemonic detected as chinese_simplified wordlist');

  // 复刻管线交叉验证：bip39 seed → SLIP-0010 → nacl → sha256(pubkey) === 真实流程输出
  const seedZh = bip39.mnemonicToSeedSync(MNEMONIC_ZH, BIP39_PASSPHRASE);
  const replicatedNodeZh = deriveSlip10Path(seedZh, DERIVATION_PATH);
  const replicatedKeypairZh = nacl.sign.keyPair.fromSeed(new Uint8Array(replicatedNodeZh.key));
  const replicatedPublicKeyZh = Buffer.from(replicatedKeypairZh.publicKey);
  assert(replicatedPublicKeyZh.toString('hex') === publicKeyHexZh, 'zh replicated SLIP-0010 publicKey matches real flow');
  assert(sha256Hex(replicatedPublicKeyZh) === rootIdZh, 'zh rootId === sha256(publicKey)');
  assert(seedZh.length === 64, 'zh seed is 64 bytes');

  // --- 2. 同一 mnemonic 派生两个 domain（真实 deriveDomainIdentity） ---
  const domains = ['chat', '文档协作'];
  const domainIdentities = domains.map((domain) => {
    const derived = managerZh.deriveDomainIdentity(domain);
    const digest = createHash('sha256').update(domain, 'utf8').digest();
    const idxA = digest.readUInt32BE(0) & 0x7fffffff;
    const idxB = digest.readUInt32BE(4) & 0x7fffffff;
    const expectedPath = `${DERIVATION_PATH}/${idxA}'/${idxB}'`;
    assert(derived.derivationPath === expectedPath, `domain "${domain}" derivation path matches sha256(domain) indexes`);
    const publicKeyHex = publicKeyHexFromBase64(derived.publicKey);
    assert(sha256Hex(Buffer.from(publicKeyHex, 'hex')) === derived.domainId, `domain "${domain}" domainId === sha256(domainPublicKey)`);
    return {
      domain,
      domainSha256Hex: digest.toString('hex'),
      idxA,
      idxB,
      derivationPath: derived.derivationPath,
      publicKeyHex,
      publicKeyBase64: derived.publicKey,
      domainId: derived.domainId
    };
  });
  assert(domainIdentities[0].publicKeyHex !== domainIdentities[1].publicKeyHex, 'two domains yield distinct keypairs');

  // --- 3. 英文 mnemonic（v1 兼容路径）→ 真实 recover ---
  const dirEn = makeTmpDir('en');
  const managerEn = new RootIdentityManager(dirEn);
  const { rootId: rootIdEn } = await managerEn.recoverFromMnemonic(MNEMONIC_EN, V2_PASSWORD, 'Vector User');
  const publicKeyBase64En = managerEn.getUnlockedPublicKeyBase64()!;
  const publicKeyHexEn = publicKeyHexFromBase64(publicKeyBase64En);
  const storedEn = JSON.parse(readFileSync(path.join(dirEn, 'identities', `${rootIdEn}.json`), 'utf8'));
  assert(storedEn.wordlist === 'english', 'en mnemonic detected as english wordlist (v1 legacy path)');
  const seedEn = bip39.mnemonicToSeedSync(MNEMONIC_EN, BIP39_PASSPHRASE);
  const replicatedPublicKeyEn = Buffer.from(
    nacl.sign.keyPair.fromSeed(new Uint8Array(deriveSlip10Path(seedEn, DERIVATION_PATH).key)).publicKey
  );
  assert(replicatedPublicKeyEn.toString('hex') === publicKeyHexEn, 'en replicated publicKey matches real flow');
  assert(sha256Hex(replicatedPublicKeyEn) === rootIdEn, 'en rootId === sha256(publicKey)');

  // --- 4. scrypt v2：固定 password+salt+iv 加解密往返（复刻实现，经真实 initialize 交叉验证） ---
  const v2Plaintext = JSON.stringify({ mnemonic: MNEMONIC_ZH, derivationPath: DERIVATION_PATH });
  const v2Encrypted = v2Encrypt(V2_PASSWORD, v2Plaintext, V2_SALT, V2_IV);
  const v2Roundtrip = v2Decrypt(V2_PASSWORD, V2_SALT, V2_IV, v2Encrypted.ciphertext, v2Encrypted.authTag);
  assert(v2Roundtrip === v2Plaintext, 'v2 decrypt(encrypt(x)) === x roundtrip');

  // 交叉验证：真实 initialize()（内部 encryptRootSecret，随机 salt/iv）落盘文件，用复刻 decrypt 解出
  const dirV2 = makeTmpDir('v2');
  const managerV2 = new RootIdentityManager(dirV2);
  const { rootId: rootIdV2, mnemonic: mnemonicV2 } = await managerV2.initialize(V2_PASSWORD, '加密校验');
  const storedV2 = JSON.parse(readFileSync(path.join(dirV2, 'identities', `${rootIdV2}.json`), 'utf8'));
  assert(storedV2.version === 2, 'real v2 file version === 2');
  assert(storedV2.kdf.name === 'scrypt', 'real v2 kdf name is scrypt');
  assert(
    storedV2.kdf.N === SCRYPT_PARAMS.N && storedV2.kdf.r === SCRYPT_PARAMS.r && storedV2.kdf.p === SCRYPT_PARAMS.p && storedV2.kdf.keyLen === SCRYPT_PARAMS.keyLen,
    'real v2 kdf params match spec constants'
  );
  assert(storedV2.encryption.algorithm === 'aes-256-gcm', 'real v2 cipher is aes-256-gcm');
  const decryptedStoredV2 = v2Decrypt(
    V2_PASSWORD,
    Buffer.from(storedV2.kdf.salt, 'base64'),
    Buffer.from(storedV2.encryption.iv, 'base64'),
    Buffer.from(storedV2.encryption.ciphertext, 'base64'),
    Buffer.from(storedV2.encryption.tag, 'base64')
  );
  assert(
    decryptedStoredV2 === JSON.stringify({ mnemonic: mnemonicV2, derivationPath: DERIVATION_PATH }),
    'replicated v2 decrypt opens real encryptRootSecret output (impl parity)'
  );

  // --- 5. pbkdf2 v1：固定 password+salt+iv 加解密往返（复刻实现，经真实 unlock 交叉验证） ---
  const v1Plaintext = JSON.stringify({ mnemonic: MNEMONIC_EN, derivationPath: DERIVATION_PATH });
  const v1Ciphertext = v1Encrypt(V1_PASSWORD, v1Plaintext, V1_SALT, V1_IV);
  const v1Roundtrip = v1Decrypt(V1_PASSWORD, V1_SALT, V1_IV, v1Ciphertext);
  assert(v1Roundtrip === v1Plaintext, 'v1 decrypt(encrypt(x)) === x roundtrip');

  // 交叉验证：用复刻的 v1 密文构造 v1 身份文件，真实 unlock() 成功解锁英文身份
  const dirV1 = makeTmpDir('v1');
  mkdirSync(path.join(dirV1, 'identities'), { recursive: true });
  const v1File = {
    version: 1,
    rootId: rootIdEn,
    publicKey: publicKeyBase64En,
    createdAt: 1700000000000,
    kdf: {
      salt: V1_SALT.toString('base64'),
      iterations: PBKDF2_PARAMS.iterations,
      keyLen: PBKDF2_PARAMS.keyLen,
      digest: PBKDF2_PARAMS.digest
    },
    encryption: {
      iv: V1_IV.toString('base64'),
      algorithm: 'aes-256-cbc',
      ciphertext: v1Ciphertext.toString('base64')
    }
  };
  writeFileSync(path.join(dirV1, 'identities', `${rootIdEn}.json`), JSON.stringify(v1File, null, 2), 'utf8');
  const managerV1 = new RootIdentityManager(dirV1);
  const unlockedV1 = await managerV1.unlock(V1_PASSWORD, rootIdEn);
  assert(unlockedV1.rootId === rootIdEn, 'real unlock() opens replicated v1 ciphertext (impl parity)');
  assert(managerV1.getUnlockedPublicKeyBase64() === publicKeyBase64En, 'v1-unlocked publicKey matches en identity');

  const hash64 = /^[0-9a-f]{64}$/;
  for (const [label, value] of [
    ['zh rootId', rootIdZh],
    ['zh publicKeyHex length', publicKeyHexZh.length === 64 ? rootIdZh : ''],
    ['en rootId', rootIdEn],
    ['domain0 domainId', domainIdentities[0].domainId]
  ] as Array<[string, string]>) {
    assert(hash64.test(value), `${label} is 64-char lowercase hex`);
  }

  return {
    meta: {
      title: 'identity golden vectors（identity.md §7）',
      generatedBy: 'desktop/scripts/extract-vectors.mts（npm run vectors:extract）',
      source: 'desktop/src/main/identity/root-id.ts',
      deterministic: '所有随机值硬编码为常量；重复运行字节级一致',
      crossChecks: [
        'rootId/publicKey：复刻 bip39→SLIP-0010→ed25519 管线 === RootIdentityManager 真实 recover 流程输出',
        'scrypt v2：复刻 decrypt 成功解开真实 initialize()（内部 encryptRootSecret）落盘的密文',
        'pbkdf2 v1：真实 unlock() 成功解开复刻 encrypt 产出的 v1 密文身份文件'
      ]
    },
    constants: {
      bip39: { entropyBits: 256, passphrase: BIP39_PASSPHRASE, defaultWordlist: 'chinese_simplified', recoveryWordlists: ['chinese_simplified', 'english'] },
      derivationPath: DERIVATION_PATH,
      rootIdRule: 'rootId = sha256hex(publicKey)；publicKey = ed25519(nacl 兼容) fromSeed(SLIP-0010 末级节点 key)'
    },
    rootIdentityChinese: {
      mnemonic: MNEMONIC_ZH,
      wordlist: 'chinese_simplified',
      derivationPath: DERIVATION_PATH,
      seedHex: seedZh.toString('hex'),
      publicKeyHex: publicKeyHexZh,
      publicKeyBase64: publicKeyBase64Zh,
      rootId: rootIdZh
    },
    domainIdentities,
    rootIdentityEnglishV1: {
      mnemonic: MNEMONIC_EN,
      wordlist: 'english',
      derivationPath: DERIVATION_PATH,
      seedHex: seedEn.toString('hex'),
      publicKeyHex: publicKeyHexEn,
      publicKeyBase64: publicKeyBase64En,
      rootId: rootIdEn
    },
    scryptV2: {
      kdf: { name: 'scrypt', ...SCRYPT_PARAMS },
      cipher: 'aes-256-gcm',
      password: V2_PASSWORD,
      saltHex: V2_SALT.toString('hex'),
      saltBase64: V2_SALT.toString('base64'),
      ivHex: V2_IV.toString('hex'),
      ivBase64: V2_IV.toString('base64'),
      plaintextJson: v2Plaintext,
      ciphertextHex: v2Encrypted.ciphertext.toString('hex'),
      ciphertextBase64: v2Encrypted.ciphertext.toString('base64'),
      authTagHex: v2Encrypted.authTag.toString('hex'),
      authTagBase64: v2Encrypted.authTag.toString('base64'),
      roundtrip: 'ok',
      realImplCrossCheck: 'ok（复刻 decrypt 解开真实 encryptRootSecret 输出；kdf/cipher 参数与真实落盘文件一致）'
    },
    pbkdf2V1: {
      kdf: { name: 'pbkdf2', ...PBKDF2_PARAMS },
      cipher: 'aes-256-cbc',
      password: V1_PASSWORD,
      saltHex: V1_SALT.toString('hex'),
      saltBase64: V1_SALT.toString('base64'),
      ivHex: V1_IV.toString('hex'),
      ivBase64: V1_IV.toString('base64'),
      plaintextJson: v1Plaintext,
      ciphertextHex: v1Ciphertext.toString('hex'),
      ciphertextBase64: v1Ciphertext.toString('base64'),
      roundtrip: 'ok',
      realImplCrossCheck: 'ok（真实 unlock() 解开复刻 encrypt 产出的 v1 密文身份文件）'
    }
  };
}

// ---------------------------------------------------------------------------
// sync-evidence.json
// ---------------------------------------------------------------------------

class MemoryDb {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async batch(operations: Array<{ type: 'put' | 'del'; key: string; value?: string }>): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        this.map.set(op.key, op.value ?? '');
      } else {
        this.map.delete(op.key);
      }
    }
  }
}

async function extractSyncEvidenceVectors() {
  // --- 1. normalizeObject 用例（复刻实现；每个用例经真实 buildEvidencePayloadHash 交叉校验） ---
  const normalizeCases: Array<{ name: string; inputExpr: string; value: any; includeInput: boolean }> = [
    { name: 'nested-object', inputExpr: '{"z":{"b":2,"a":1},"a":[{"x":null}],"s":"hi"}', value: { z: { b: 2, a: 1 }, a: [{ x: null }], s: 'hi' }, includeInput: true },
    // 数组下标是 canonical 整数字符串：尽管 normalizeObject 内部按字典序 sort，
    // JSON.stringify 对整数型 key 恒按数值升序输出（JS 对象 key 序规则），"10" 落在 "9" 之后
    { name: 'array-indices-numeric-order', inputExpr: '[0,1,2,3,4,5,6,7,8,9,10]', value: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], includeInput: true },
    // 混合型 key："2"/"10" 是数组下标（数值升序优先）；"4294967295" 超出数组下标范围（≥2^32-1），
    // 按普通字符串 key 排在整数 key 之后（此层才体现字典序 sort 的插入序）
    { name: 'integer-like-keys-ordering', inputExpr: '{"2":"a","10":"b","4294967295":"c"}', value: { 2: 'a', 10: 'b', 4294967295: 'c' }, includeInput: true },
    { name: 'array-mixed-nesting', inputExpr: '[1,"two",null,{"k":"v"},[true]]', value: [1, 'two', null, { k: 'v' }, [true]], includeInput: true },
    { name: 'null-literal', inputExpr: 'null', value: null, includeInput: true },
    { name: 'undefined-literal', inputExpr: 'undefined', value: undefined, includeInput: false },
    { name: 'integer', inputExpr: '42', value: 42, includeInput: true },
    { name: 'float', inputExpr: '3.14', value: 3.14, includeInput: true },
    { name: 'float-precision', inputExpr: '0.1 + 0.2', value: 0.1 + 0.2, includeInput: true },
    { name: 'large-number-exponent', inputExpr: '1e21', value: 1e21, includeInput: true },
    { name: 'negative-zero', inputExpr: '-0', value: -0, includeInput: false },
    { name: 'chinese-string', inputExpr: '"你好，世界"', value: '你好，世界', includeInput: true },
    { name: 'escape-string', inputExpr: '"换行\\n引号\\"反斜杠\\\\"', value: '换行\n引号"反斜杠\\', includeInput: true },
    { name: 'unsorted-keys', inputExpr: '{"b":1,"a":2,"A":3}（key 按 UTF-16 code unit 排序）', value: { b: 1, a: 2, A: 3 }, includeInput: true },
    { name: 'boolean', inputExpr: 'true', value: true, includeInput: true },
    { name: 'empty-array-becomes-object', inputExpr: '[]', value: [], includeInput: true },
    { name: 'empty-object', inputExpr: '{}', value: {}, includeInput: true }
  ];

  const normalizeObjectVectors = normalizeCases.map((c) => {
    const expected = normalizeObject(c.value);
    // 交叉校验 1（直接）：null/undefined 顶层会被真实 buildEvidencePayloadHash 短路，跳过
    if (c.value !== null && c.value !== undefined) {
      assert(buildEvidencePayloadHash(c.value) === sha256Hex(expected), `normalizeObject[${c.name}] direct hash matches real impl`);
    }
    // 交叉校验 2（包裹 {v: input}）：覆盖 null/undefined 落入 object 递归分支的行为
    assert(
      buildEvidencePayloadHash({ v: c.value }) === sha256Hex(normalizeObject({ v: c.value })),
      `normalizeObject[${c.name}] wrapped hash matches real impl`
    );
    const vector: Record<string, unknown> = { name: c.name, inputExpr: c.inputExpr, expected, verifiedAgainstRealImpl: true };
    if (c.includeInput) {
      vector.input = c.value;
    }
    return vector;
  });

  // --- 2. payloadHash / metaHash / dataHash / entryHash 固定输入（真实函数） ---
  const payloadHashCases = [
    { input: { text: '你好', seq: 1 }, note: 'object' },
    { input: '纯字符串 payload', note: 'string' },
    { input: 42, note: 'number' },
    { input: null, note: 'null → null（短路，不哈希）' },
    { input: undefined as any, note: 'undefined → null（短路，不哈希）' }
  ].map((c) => ({
    input: c.input === undefined ? null : c.input,
    inputKind: c.input === undefined ? 'undefined' : undefined,
    note: c.note,
    payloadHash: buildEvidencePayloadHash(c.input)
  }));

  const metaHashCases = [
    { input: { vv: { nodeA: 1 }, ts: 1700000000000, nodeId: 'nodeA' }, note: 'sync meta' },
    { input: { vv: { nodeA: 3 }, ts: 1700000002000, tombstone: true }, note: 'tombstone meta' },
    { input: null, note: 'null → null' }
  ].map((c) => ({ input: c.input, note: c.note, metaHash: buildEvidenceMetaHash(c.input) }));

  const dataHashCases = [
    { domain: 'chat', collection: 'messages', id: 'msg-001', op: 'put' as const, payloadHash: buildEvidencePayloadHash({ text: '你好', seq: 1 }), metaHash: buildEvidenceMetaHash({ vv: { nodeA: 1 }, ts: 1700000000000, nodeId: 'nodeA' }) },
    { domain: 'chat', collection: 'messages', id: 'msg-001', op: 'delete' as const, payloadHash: null, metaHash: buildEvidenceMetaHash({ vv: { nodeA: 3 }, ts: 1700000002000 }) }
  ].map((c) => ({ ...c, dataHash: buildEvidenceDataHash(c.domain, c.collection, c.id, c.op, c.payloadHash, c.metaHash) }));

  const entryHashCase = {
    seq: 1,
    prevHash: null,
    domain: 'chat',
    collection: 'messages',
    id: 'msg-001',
    op: 'put' as const,
    dataHash: dataHashCases[0].dataHash,
    payloadHash: dataHashCases[0].payloadHash,
    metaHash: dataHashCases[0].metaHash,
    timestamp: 1700000000000,
    nodeId: 'nodeA'
  };
  const entryHashCases = [{ entry: entryHashCase, hash: buildEvidenceEntryHash(entryHashCase) }];

  // --- 3. 内存 fake LevelDB 连建 3 条链式存证（真实 appendEvidence / verifyEvidenceChain） ---
  const db = new MemoryDb();
  const chainInputs = [
    { domain: 'chat', collection: 'messages', id: 'msg-001', op: 'put' as const, payload: { text: '你好', seq: 1 }, meta: { vv: { nodeA: 1 }, ts: 1700000000000, nodeId: 'nodeA' }, timestamp: 1700000000000, nodeId: 'nodeA' },
    { domain: 'chat', collection: 'messages', id: 'msg-002', op: 'put' as const, payload: { text: 'second message', seq: 2 }, meta: { vv: { nodeA: 2 }, ts: 1700000001000, nodeId: 'nodeA' }, timestamp: 1700000001000, nodeId: 'nodeA' },
    { domain: 'chat', collection: 'messages', id: 'msg-001', op: 'delete' as const, payload: null, meta: { vv: { nodeA: 3 }, ts: 1700000002000, nodeId: 'nodeA', tombstone: true }, timestamp: 1700000002000, nodeId: 'nodeA' }
  ];
  const chainEntries = [];
  for (const input of chainInputs) {
    const payloadHash = buildEvidencePayloadHash(input.payload);
    const metaHash = buildEvidenceMetaHash(input.meta);
    const dataHash = buildEvidenceDataHash(input.domain, input.collection, input.id, input.op, payloadHash, metaHash);
    const entry = await appendEvidence(db as any, {
      domain: input.domain,
      collection: input.collection,
      id: input.id,
      op: input.op,
      dataHash,
      payloadHash,
      metaHash,
      timestamp: input.timestamp,
      nodeId: input.nodeId
    });
    chainEntries.push(entry);
  }
  assert(chainEntries[0].seq === 1 && chainEntries[0].prevHash === null, 'chain head: seq=1 prevHash=null');
  assert(chainEntries[1].prevHash === chainEntries[0].hash && chainEntries[2].prevHash === chainEntries[1].hash, 'chain prevHash linkage');
  const chainVerifyResult = await verifyEvidenceChain(db as any);
  assert(chainVerifyResult === true, 'verifyEvidenceChain over fake db returns true');
  for (const entry of chainEntries) {
    assert(/^[0-9a-f]{64}$/.test(entry.hash), `chain entry seq=${entry.seq} hash is 64-hex`);
  }

  // --- 4. compareVersionVectors 全分支（真实函数） ---
  const vvCases: Array<{ local: Record<string, number> | null; remote: Record<string, number> | null; branch: string }> = [
    { local: null, remote: null, branch: 'both-null → equal' },
    { local: { a: 1 }, remote: null, branch: 'remote-null → local' },
    { local: null, remote: { a: 1 }, branch: 'local-null → remote' },
    { local: { a: 2 }, remote: { a: 1 }, branch: 'local strictly greater → local' },
    { local: { a: 1 }, remote: { a: 2 }, branch: 'remote strictly greater → remote' },
    { local: { a: 1 }, remote: { a: 1 }, branch: 'identical → equal' },
    { local: { a: 1, b: 1 }, remote: { a: 1 }, branch: 'local superset → local' },
    { local: { a: 1 }, remote: { a: 1, b: 1 }, branch: 'remote superset → remote' },
    { local: { a: 2, b: 1 }, remote: { a: 1, b: 2 }, branch: 'each greater on some key → concurrent' },
    { local: {}, remote: {}, branch: 'both empty → equal' }
  ];
  const compareVersionVectorsVectors = vvCases.map((c) => ({ ...c, result: compareVersionVectors(c.local, c.remote) }));

  // --- 5. resolveConflictByLWW 全分支（真实函数） ---
  const lwwCases: Array<{ localTs: number | null; remoteTs: number | null; branch: string }> = [
    { localTs: null, remoteTs: null, branch: 'both null → 0 vs 0 → equal' },
    { localTs: 5, remoteTs: null, branch: 'remote null 按 0 → local' },
    { localTs: null, remoteTs: 5, branch: 'local null 按 0 → remote' },
    { localTs: 10, remoteTs: 5, branch: 'l > r → local' },
    { localTs: 5, remoteTs: 10, branch: 'r > l → remote' },
    { localTs: 7, remoteTs: 7, branch: '严格比较，相等 → equal' },
    { localTs: -5, remoteTs: null, branch: '负数时间戳：-5 < 0 → remote' }
  ];
  const lwwVectors = lwwCases.map((c) => ({ ...c, result: resolveConflictByLWW(c.localTs, c.remoteTs) }));

  // --- 6. mergeVersionVectors（复刻实现，标注 replicated；sync.ts 中未导出） ---
  const mergeCases: Array<{ local: Record<string, number> | null; remote: Record<string, number> | null }> = [
    { local: { a: 1 }, remote: { a: 2, b: 3 } },
    { local: null, remote: { a: 1 } },
    { local: { a: 5 }, remote: null },
    { local: null, remote: null }
  ];
  const mergeVectors = mergeCases.map((c) => ({ ...c, merged: mergeVersionVectors(c.local, c.remote), note: 'replicated（mergeVersionVectors 未从 sync.ts 导出，按源码逐行复刻）' }));

  // --- 7. resolveSchemaDeclaration 全分支（真实函数，含抛错用例） ---
  const schemaCases: Array<{ name: string; declaration: any }> = [
    { name: 'append-only 默认：enableEvidence 强制 true', declaration: { syncStrategy: 'append-only' } },
    { name: 'append-only 显式关 evidence 仍强制 true', declaration: { syncStrategy: 'append-only', enableEvidence: false } },
    { name: 'governance + append-only：evidence 强制 true', declaration: { syncStrategy: 'append-only', governance: true } },
    { name: 'governance + lww：禁止降级，抛错', declaration: { syncStrategy: 'lww', governance: true } },
    { name: 'lww 默认：enableEvidence=false', declaration: { syncStrategy: 'lww' } },
    { name: 'lww 显式开 evidence', declaration: { syncStrategy: 'lww', enableEvidence: true } },
    { name: '非法 syncStrategy 抛错', declaration: { syncStrategy: 'merge' } },
    { name: '空声明抛错', declaration: null }
  ];
  const schemaVectors = schemaCases.map((c) => {
    try {
      return { name: c.name, declaration: c.declaration, result: resolveSchemaDeclaration(c.declaration) };
    } catch (error) {
      return { name: c.name, declaration: c.declaration, error: (error as Error).message };
    }
  });
  assert(schemaVectors[3].error !== undefined && schemaVectors[6].error !== undefined && schemaVectors[7].error !== undefined, 'schema error branches throw');

  return {
    meta: {
      title: 'sync-evidence golden vectors（sync-evidence.md §5）',
      generatedBy: 'desktop/scripts/extract-vectors.mts（npm run vectors:extract）',
      source: 'desktop/src/main/db/{evidence,sync,schema}.ts',
      deterministic: '所有输入（含 timestamp）硬编码为常量；重复运行字节级一致',
      crossChecks: [
        'normalizeObject 为 evidence.ts 私有函数：脚本逐行复刻，每个用例经真实 buildEvidencePayloadHash 做 sha256 交叉校验（顶层直接 + {v:...} 包裹两种）',
        'hash/链/vv/lww/schema 用例全部直接调用真实导出函数',
        'evidenceChain.verifyChainResult 为真实 verifyEvidenceChain 在内存 fake LevelDB 上的执行结果'
      ]
    },
    normalizeObject: normalizeObjectVectors,
    payloadHash: payloadHashCases,
    metaHash: metaHashCases,
    dataHash: dataHashCases,
    entryHash: entryHashCases,
    evidenceChain: {
      storageKeys: {
        proofKeyPattern: 'doc:evidence:proof:{seq 左补零至 12 位}',
        proofKeys: chainEntries.map((e) => evidenceKey(e.seq)),
        headKey: 'doc:evidence:head'
      },
      entries: chainEntries,
      head: { seq: chainEntries[2].seq, hash: chainEntries[2].hash },
      verifyChainResult: chainVerifyResult
    },
    compareVersionVectors: compareVersionVectorsVectors,
    resolveConflictByLWW: lwwVectors,
    mergeVersionVectors: mergeVectors,
    resolveSchemaDeclaration: schemaVectors,
    schemaDefaults: {
      DEFAULT_COLLECTION_POLICY,
      collectionSchemaKeyExample: { domain: 'chat', collection: 'messages', key: collectionSchemaKey('chat', 'messages') }
    }
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const identity = await extractIdentityVectors();
  const syncEvidence = await extractSyncEvidenceVectors();

  mkdirSync(vectorsDir, { recursive: true });
  const identityPath = path.join(vectorsDir, 'identity.json');
  const syncEvidencePath = path.join(vectorsDir, 'sync-evidence.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n', 'utf8');
  writeFileSync(syncEvidencePath, JSON.stringify(syncEvidence, null, 2) + '\n', 'utf8');

  console.log('[extract-vectors] all checks passed:', checkCount);
  console.log('[extract-vectors] wrote', identityPath);
  console.log('  - rootId(zh):', identity.rootIdentityChinese.rootId);
  console.log('  - rootId(en):', identity.rootIdentityEnglishV1.rootId);
  console.log('  - domains:', identity.domainIdentities.map((d) => `${d.domain}→idxA=${d.idxA},idxB=${d.idxB}`).join(' | '));
  console.log('[extract-vectors] wrote', syncEvidencePath);
  console.log('  - normalizeObject cases:', syncEvidence.normalizeObject.length);
  console.log('  - chain head:', JSON.stringify(syncEvidence.evidenceChain.head));
}

main()
  .catch((error) => {
    console.error('[extract-vectors] FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
