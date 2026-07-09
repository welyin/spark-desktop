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
    broadcast: (topic, message) => ipcRenderer.invoke('p2p-broadcast', topic, message)
  },
  plugin: {
    openView: (pluginDomain, pluginView = 'default') =>
      ipcRenderer.invoke('plugin-open-view', pluginDomain, pluginView)
  },
  organization: {
    listMine: () => ipcRenderer.invoke('org-list-mine'),
    create: (input) => ipcRenderer.invoke('org-create', input),
    delete: (orgId) => ipcRenderer.invoke('org-delete', orgId),
    addMember: (orgId, memberRootId) => ipcRenderer.invoke('org-add-member', orgId, memberRootId),
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
  getDomain: () => ipcRenderer.invoke('get-current-domain')
};

console.log('[preload.js] exposing electronAPI');
contextBridge.exposeInMainWorld('electronAPI', api);
