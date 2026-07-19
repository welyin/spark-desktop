import { rootIdentityManager } from '../identity';
import { isP2PInitialized, getP2PNode } from '../p2p/index';
import { getUpdaterService } from '../updater';
import { ensureCoreServicesStarted } from '../bootstrap';
import { getCallerDomain, registerInvokeHandler, requireSystemDomain } from './helpers';

/**
 * 根身份与窗口域查询相关 IPC
 */
export function registerIdentityHandlers(): void {
  registerInvokeHandler('root-status', async (event) => {
    requireSystemDomain(event);
    return await rootIdentityManager.getStatus();
  });

  registerInvokeHandler('root-init', async (event, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.initialize(password);
    return {
      rootId: result.rootId,
      mnemonic: result.mnemonic
    };
  });

  registerInvokeHandler('root-unlock', async (event, password: string) => {
    requireSystemDomain(event);
    const result = await rootIdentityManager.unlock(password);

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
