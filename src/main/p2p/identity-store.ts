import type { LevelDB } from '../db/base';
import { P2P_IDENTITY_PRIVATE_KEY } from './constants';

/**
 * 读取或创建 libp2p 私钥。
 *
 * 设计目标：同一设备重启后保持 PeerId 不变，避免“每次登录都是新节点”。
 * 行为：
 * 1) 先尝试从 LevelDB 读取 base64 编码私钥；
 * 2) 读取失败或反序列化失败时自动重建；
 * 3) 新私钥会立即写回数据库用于后续复用。
 */
export async function getOrCreateLibp2pPrivateKey(db: LevelDB, runtimeImport: (specifier: string) => Promise<any>): Promise<any> {
  const { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } = await runtimeImport('@libp2p/crypto/keys');
  const encoded = await db.get(P2P_IDENTITY_PRIVATE_KEY);
  if (encoded) {
    try {
      return privateKeyFromProtobuf(Buffer.from(encoded, 'base64'));
    } catch (error) {
      console.warn('[p2p] failed to load persisted private key, regenerate', error);
    }
  }

  const privateKey = await generateKeyPair('Ed25519');
  const raw = privateKeyToProtobuf(privateKey);
  await db.put(P2P_IDENTITY_PRIVATE_KEY, Buffer.from(raw).toString('base64'));
  return privateKey;
}
