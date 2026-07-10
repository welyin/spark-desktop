/**
 * P2P 模块入口：保留单例生命周期与对外导出，具体实现拆分到子模块。
 */
import type { LevelDB } from '../db/base';
import { P2PNode } from './p2p-node';
import type { P2PIdentityContext } from './types';

type P2PNodeRuntimeOptions = {
  appVersion?: string;
  onPeerVersionObserved?: (version: string, peerId: string) => Promise<void> | void;
};

export type { LocalP2PNodeInfo, P2PIdentityContext, P2PMessageBody, PeerNodeInfo } from './types';
export { P2PNode } from './p2p-node';

let p2pNodeInstance: P2PNode | null = null;

/**
 * 初始化全局 P2P 单例。
 *
 * 约束：主进程只允许初始化一次，重复调用会抛错，防止重复绑定网络事件。
 */
export function initP2PNode(
  db: LevelDB,
  identityContext?: P2PIdentityContext,
  runtimeOptions?: P2PNodeRuntimeOptions
): P2PNode {
  if (p2pNodeInstance) {
    throw new Error('P2P node already initialized. Call initP2PNode only once.');
  }
  p2pNodeInstance = new P2PNode(db, identityContext, runtimeOptions);
  return p2pNodeInstance;
}

/**
 * 获取已初始化的 P2P 单例。
 * 未初始化时抛错，强制调用方遵循 init -> use 顺序。
 */
export function getP2PNode(): P2PNode {
  if (!p2pNodeInstance) {
    throw new Error('P2P node not initialized. Call initP2PNode(db) first.');
  }
  return p2pNodeInstance;
}

/**
 * 检查是否已完成初始化。
 * 适用于启动流程中的防御式判断或诊断展示。
 */
export function isP2PInitialized(): boolean {
  return p2pNodeInstance !== null;
}
