const { contextBridge, ipcRenderer } = require('electron');

const api = {
  db: {
    open: () => ipcRenderer.invoke('db-open'),
    close: () => ipcRenderer.invoke('db-close'),
    get: (key) => ipcRenderer.invoke('db-get', key),
    put: (key, value) => ipcRenderer.invoke('db-put', key, value),
    del: (key) => ipcRenderer.invoke('db-del', key),
    batch: (operations) => ipcRenderer.invoke('db-batch', operations),
    query: (prefix) => ipcRenderer.invoke('db-query', prefix),
    path: () => ipcRenderer.invoke('db-path'),
    status: () => ipcRenderer.invoke('db-status')
  },
  evidence: {
    headHash: () => ipcRenderer.invoke('evidence-head-hash'),
    verify: () => ipcRenderer.invoke('evidence-verify')
  },
  p2p: {
    start: () => ipcRenderer.invoke('p2p-start'),
    stop: () => ipcRenderer.invoke('p2p-stop'),
    broadcast: (topic, message) => ipcRenderer.invoke('p2p-broadcast', topic, message),
    clearPeerRecords: () => ipcRenderer.invoke('p2p-clear-peer-records'),
    syncPeerOrganizations: (targetPeer) => {
      const payload = {
        peerId: targetPeer && targetPeer.peerId ? targetPeer.peerId : undefined,
        addresses: Array.isArray(targetPeer && targetPeer.addresses)
          ? targetPeer.addresses.map((item) => String(item))
          : []
      };
      return ipcRenderer.invoke('p2p-sync-peer-organizations', payload);
    },
    info: () => ipcRenderer.invoke('p2p-info')
  },
  plugin: {
    openView: (pluginDomain, pluginView = 'default') =>
      ipcRenderer.invoke('plugin-open-view', pluginDomain, pluginView),
    listCatalog: () => ipcRenderer.invoke('plugin-list-catalog'),
    currentRoot: () => ipcRenderer.invoke('plugin-current-root'),
    listMineOrganizations: (pluginDomain) => ipcRenderer.invoke('plugin-org-list-mine', pluginDomain),
    docGet: (collection, id, pluginDomain) => ipcRenderer.invoke('plugin-doc-get', collection, id, pluginDomain),
    docPut: (collection, id, doc, pluginDomain) => ipcRenderer.invoke('plugin-doc-put', collection, id, doc, pluginDomain),
    docDelete: (collection, id, pluginDomain) => ipcRenderer.invoke('plugin-doc-delete', collection, id, pluginDomain),
    docQuery: (collection, options = {}, pluginDomain) => ipcRenderer.invoke('plugin-doc-query', collection, options, pluginDomain)
  },
  pluginMarket: {
    list: () => ipcRenderer.invoke('plugin-market-list'),
    checkUpdates: (pluginId) => ipcRenderer.invoke('plugin-market-check-updates', pluginId),
    install: (pluginId) => ipcRenderer.invoke('plugin-market-install', pluginId),
    upgrade: (pluginId) => ipcRenderer.invoke('plugin-market-upgrade', pluginId),
    setEnabled: (pluginId, enabled) => ipcRenderer.invoke('plugin-market-set-enabled', pluginId, enabled)
  },
  organization: {
    listMine: () => ipcRenderer.invoke('org-list-mine'),
    create: (input) => ipcRenderer.invoke('org-create', input),
    delete: (orgId) => ipcRenderer.invoke('org-delete', orgId),
    addMember: (orgId, input) => ipcRenderer.invoke('org-add-member', orgId, input),
    removeMember: (orgId, memberRootId) => ipcRenderer.invoke('org-remove-member', orgId, memberRootId)
  },
  rootIdentity: {
    status: () => ipcRenderer.invoke('root-status'),
    initialize: (password) => ipcRenderer.invoke('root-init', password),
    unlock: (password) => ipcRenderer.invoke('root-unlock', password),
    lock: () => ipcRenderer.invoke('root-lock'),
    sign: (payload) => ipcRenderer.invoke('root-sign', payload),
    deriveDomain: (domain) => ipcRenderer.invoke('root-derive-domain', domain)
  },
  updater: {
    status: () => ipcRenderer.invoke('update-status'),
    check: () => ipcRenderer.invoke('update-check'),
    stageLatest: () => ipcRenderer.invoke('update-stage-latest'),
    applyRestart: () => ipcRenderer.invoke('update-apply-restart'),
    observePeerVersion: (version) => ipcRenderer.invoke('update-observe-peer-version', version)
  },
  getDomain: () => ipcRenderer.invoke('get-current-domain')
};

console.log('[preload.js] exposing electronAPI');
contextBridge.exposeInMainWorld('electronAPI', api);
