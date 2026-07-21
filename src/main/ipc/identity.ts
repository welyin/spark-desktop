import { rootIdentityManager, splitMnemonicInput, findInvalidMnemonicWords } from '../identity';
import { isP2PInitialized, getP2PNode } from '../p2p/index';
import { getUpdaterService } from '../updater';
import { ensureCoreServicesStarted, ensureStorageReady } from '../bootstrap';
import { getCallerDomain, registerInvokeHandler, requireSystemDomain } from './helpers';

/**
 * 根身份与窗口域查询相关 IPC
 */
export function registerIdentityHandlers(): void {
  /** 登录/恢复成功后的后台引导：更新检查 + 核心服务与组织网络重连 */
  const runPostUnlockBootstrap = () => {
    void getUpdaterService().checkForUpdates('startup').catch((error) => {
      console.warn('[main] post-login update check failed', error);
    });

    // 登录成功后立即返回给 UI，后台异步执行节点重连与数据对账。
    void (async () => {
      try {
        await ensureCoreServicesStarted();
        if (isP2PInitialized() && getP2PNode().isStarted()) {
          await getP2PNode().bootstrapOrganizationNetworkOnLogin();
        }
      } catch (error) {
        console.warn('[main] failed to bootstrap organization peers after login', error);
      }
    })();
  };

  registerInvokeHandler('root-status', async (event) => {
    requireSystemDomain(event);
    return await rootIdentityManager.getStatus();
  });

  registerInvokeHandler('root-init', async (event, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.initialize(password);
    // 返回前完成存储对齐（新用户切到其专属库），P2P 重连与更新检查留后台
    await ensureStorageReady();
    runPostUnlockBootstrap();
    return {
      rootId: result.rootId,
      mnemonic: result.mnemonic
    };
  });

  registerInvokeHandler('root-unlock', async (event, password: string, rootId?: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.unlock(password, rootId);
    await ensureStorageReady();
    runPostUnlockBootstrap();
    return result;
  });

  registerInvokeHandler('root-list-identities', async (event) => {
    requireSystemDomain(event);
    return rootIdentityManager.listIdentities();
  });

  registerInvokeHandler('root-set-active', async (event, rootId: string) => {
    requireSystemDomain(event);
    await rootIdentityManager.setActiveIdentity(rootId);
    return { success: true };
  });

  registerInvokeHandler('root-reveal-mnemonic', async (event, password: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.revealMnemonic(password);
  });

  registerInvokeHandler('root-backup-payload', async (event) => {
    requireSystemDomain(event);
    return rootIdentityManager.getEncryptedBackupPayload();
  });

  registerInvokeHandler('root-mnemonic-check', (event, input: string) => {
    requireSystemDomain(event);
    const words = splitMnemonicInput(input);
    return { words, invalidIndexes: findInvalidMnemonicWords(words) };
  });

  registerInvokeHandler('root-recover-mnemonic', async (event, mnemonic: string, newPassword: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.recoverFromMnemonic(mnemonic, newPassword);
    await ensureStorageReady();
    runPostUnlockBootstrap();
    return result;
  });

  registerInvokeHandler('root-recover-backup', async (event, payload: string, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.recoverFromBackup(payload, password);
    await ensureStorageReady();
    runPostUnlockBootstrap();
    return result;
  });

  registerInvokeHandler('root-lock', (event) => {
    requireSystemDomain(event);
    rootIdentityManager.lock();
    return { success: true };
  });

  registerInvokeHandler('root-sign', (event, payload: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.sign(payload);
  });

  registerInvokeHandler('root-derive-domain', (event, domain: string) => {
    requireSystemDomain(event);
    return rootIdentityManager.deriveDomainIdentity(domain);
  });

  // 查询当前窗口的可信域（只读，供 preload 展示用）
  registerInvokeHandler('get-current-domain', (event) => {
    return { domain: getCallerDomain(event) };
  });
}
