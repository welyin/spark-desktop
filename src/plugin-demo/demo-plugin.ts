import type { ElectronAPI } from '../main/preload';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export type DemoDocument = {
  id: string;
  title: string;
  value: string;
};

let currentDomain: string | null = null;

/**
 * 初始化 demo 插件环境
 * 从主进程查询当前窗口的可信域身份
 */
export async function setupDemoPlugin(): Promise<string> {
  const result = await window.electronAPI.getDomain();
  currentDomain = result.domain;
  if (!currentDomain) {
    throw new Error('Failed to get current domain from main process');
  }
  return currentDomain;
}

function getDomain(): string {
  if (!currentDomain) {
    throw new Error('Demo plugin not initialized. Call setupDemoPlugin() first.');
  }
  return currentDomain;
}

export async function writeDemoDoc(doc: DemoDocument) {
  const domain = getDomain();
  await window.electronAPI.db.put(`doc:${domain}:demo:${doc.id}`, JSON.stringify(doc));
  return doc;
}

export async function readDemoDoc(id: string): Promise<DemoDocument | null> {
  const domain = getDomain();
  const raw = await window.electronAPI.db.get(`doc:${domain}:demo:${id}`);
  return raw ? (JSON.parse(raw) as DemoDocument) : null;
}

export async function listDemoDocs(): Promise<DemoDocument[]> {
  const domain = getDomain();
  const rows = await window.electronAPI.db.query(`doc:${domain}:demo:`);
  return rows.map((row) => JSON.parse(row.value) as DemoDocument);
}

export function subscribeDemoChanges(onChange: (docs: DemoDocument[]) => void) {
  let latestSnapshot = '';
  const interval = window.setInterval(async () => {
    try {
      const docs = await listDemoDocs();
      const snapshot = JSON.stringify(docs);
      if (snapshot !== latestSnapshot) {
        latestSnapshot = snapshot;
        onChange(docs);
      }
    } catch (error) {
      console.warn('[demo-plugin] subscribe failed', error);
    }
  }, 1000);
  return () => window.clearInterval(interval);
}

export async function verifyEvidence() {
  return window.electronAPI.evidence.verify();
}

export async function startP2P() {
  return window.electronAPI.p2p.start();
}

export async function broadcastUpdate(id: string, payload: Record<string, unknown>) {
  const domain = getDomain();
  return window.electronAPI.p2p.broadcast('spark-sync', {
    type: 'update',
    domain,
    collection: 'demo',
    id,
    payload,
    meta: { info: 'demo-sync' }
  });
}