import { isKnownPluginDomain } from '../plugins/catalog';
import { organizationService } from '../bootstrap';
import { registerInvokeHandler, requireSystemDomain } from './helpers';

/**
 * 组织域管理相关 IPC（仅系统域可用）
 */
export function registerOrganizationHandlers(): void {
  registerInvokeHandler('org-list-mine', async (event) => {
    requireSystemDomain(event);
    return await organizationService.listMine();
  });

  registerInvokeHandler('org-create', async (event, input: { name: string; description?: string; basePluginDomain: string }) => {
    requireSystemDomain(event);
    if (!input?.basePluginDomain || !isKnownPluginDomain(input.basePluginDomain)) {
      throw new Error('Organization must choose a valid base plugin');
    }
    return await organizationService.createOrganization(input);
  });

  registerInvokeHandler('org-delete', async (event, orgId: string) => {
    requireSystemDomain(event);
    return await organizationService.deleteOrganization(orgId);
  });

  registerInvokeHandler('org-add-member', async (event, orgId: string, input: { rootId: string; nodeInfo: { peerId?: string; addresses: string[] } }) => {
    requireSystemDomain(event);
    return await organizationService.addMember(orgId, input);
  });

  registerInvokeHandler('org-remove-member', async (event, orgId: string, memberRootId: string) => {
    requireSystemDomain(event);
    return await organizationService.removeMember(orgId, memberRootId);
  });
}
