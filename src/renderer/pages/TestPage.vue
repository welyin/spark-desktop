<template>
  <section class="card-page">
    <h1>测试</h1>
    <p>这里是测试页面。</p>

    <section class="card nested">
      <h2>LevelDB 测试面板</h2>
      <div class="row">
        <button @click="$emit('open-db')" :disabled="dbStatus.open">打开数据库</button>
        <button @click="$emit('close-db')" :disabled="!dbStatus.open">关闭数据库</button>
      </div>
      <div class="row">
        <button @click="$emit('put-value')" :disabled="!dbStatus.open">Put 键值</button>
        <button @click="$emit('get-value')" :disabled="!dbStatus.open">Get 键值</button>
        <button @click="$emit('del-value')" :disabled="!dbStatus.open">Del 键值</button>
        <button @click="$emit('batch-ops')" :disabled="!dbStatus.open">Batch 操作</button>
      </div>
      <div class="status">
        <strong>数据库路径：</strong>{{ dbPath }}
      </div>
      <div class="status">
        <strong>打开状态：</strong>{{ dbStatus.open ? '已打开' : '已关闭' }}
      </div>
      <div class="status">
        <strong>结果：</strong>{{ resultMessage }}
      </div>
    </section>

    <section class="card nested node-panel">
      <div class="panel-title">
        <div>
          <h2>节点面板</h2>
          <p class="subtitle">展示本地保存的所有节点数据，并可按节点触发组织同步。</p>
        </div>
        <button class="secondary" @click="refreshNodes" :disabled="loadingNodes">
          {{ loadingNodes ? '刷新中...' : '刷新节点' }}
        </button>
      </div>

      <div v-if="nodeMessage" class="status message">{{ nodeMessage }}</div>
      <div v-if="loadingNodes" class="empty-state">正在加载节点...</div>
      <div v-else-if="nodeRecords.length === 0" class="empty-state">暂无保存的节点记录。</div>
      <div v-else class="node-grid">
        <article v-for="node in nodeRecords" :key="node.nodeKey" class="node-card">
          <div class="node-card-head">
            <strong>{{ node.peerId || '未解析 PeerId' }}</strong>
            <button class="sync-button" @click="syncNode(node)" :disabled="syncingNodeKey === node.nodeKey">
              {{ syncingNodeKey === node.nodeKey ? '同步中...' : '同步' }}
            </button>
          </div>
          <p class="muted">{{ node.addresses.length }} 个地址 · 最近 {{ formatDate(node.lastSeenAt) }}</p>
          <div class="node-meta">
            <span>成功 {{ node.successCount }}</span>
            <span>失败 {{ node.failureCount }}</span>
            <span>累计在线 {{ formatDuration(node.cumulativeConnectedMs) }}</span>
          </div>
          <p v-if="node.lastError" class="error-text">最后错误：{{ node.lastError }}</p>
          <p class="address-text">{{ node.addresses.join(' , ') }}</p>
        </article>
      </div>
    </section>
  </section>
</template>

<script lang="ts">
import { defineComponent, onMounted, PropType, ref } from 'vue';

type SavedNodeRecord = {
  nodeKey: string;
  peerId: string | null;
  addresses: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  successCount: number;
  failureCount: number;
  cumulativeConnectedMs: number;
  currentSessionConnectedAt?: number;
  lastError?: string;
};

export default defineComponent({
  name: 'TestPage',
  props: {
    dbStatus: {
      type: Object as PropType<{ open: boolean }>,
      required: true
    },
    dbPath: {
      type: String,
      required: true
    },
    resultMessage: {
      type: String,
      required: true
    }
  },
  emits: ['open-db', 'close-db', 'put-value', 'get-value', 'del-value', 'batch-ops'],
  setup() {
    const nodeRecords = ref<SavedNodeRecord[]>([]);
    const loadingNodes = ref(false);
    const syncingNodeKey = ref('');
    const nodeMessage = ref('');

    const parseNodeRecord = (key: string, value: string): SavedNodeRecord | null => {
      try {
        const record = JSON.parse(value) as Omit<SavedNodeRecord, 'nodeKey'>;
        return {
          nodeKey: key,
          peerId: record.peerId ?? null,
          addresses: Array.isArray(record.addresses) ? record.addresses : [],
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.lastSeenAt,
          lastConnectedAt: record.lastConnectedAt ?? null,
          lastDisconnectedAt: record.lastDisconnectedAt ?? null,
          successCount: record.successCount ?? 0,
          failureCount: record.failureCount ?? 0,
          cumulativeConnectedMs: record.cumulativeConnectedMs ?? 0,
          currentSessionConnectedAt: record.currentSessionConnectedAt,
          lastError: record.lastError
        };
      } catch {
        return null;
      }
    };

    const refreshNodes = async () => {
      loadingNodes.value = true;
      nodeMessage.value = '';
      try {
        const rows = await window.electronAPI.db.query('p2p:peer:record:');
        nodeRecords.value = rows
          .map((row) => parseNodeRecord(row.key, row.value))
          .filter((row): row is SavedNodeRecord => row !== null)
          .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
      } catch (error) {
        nodeMessage.value = `加载节点失败：${error}`;
      } finally {
        loadingNodes.value = false;
      }
    };

    const syncNode = async (node: SavedNodeRecord) => {
      syncingNodeKey.value = node.nodeKey;
      nodeMessage.value = '';
      try {
        const result = await window.electronAPI.p2p.syncPeerOrganizations({
          peerId: node.peerId ?? undefined,
          addresses: node.addresses
        });
        nodeMessage.value = `节点同步完成：推送尝试 ${result.attempted} / 成功 ${result.synced}；拉取检查 ${result.pullChecked} / 更新 ${result.pullSynced}；移除本地组织 ${result.removed}`;
      } catch (error) {
        nodeMessage.value = `节点同步失败：${error}`;
      } finally {
        syncingNodeKey.value = '';
      }
    };

    const formatDate = (timestamp: number) => {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(timestamp));
    };

    const formatDuration = (durationMs: number) => {
      const minutes = Math.floor(durationMs / 60000);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) {
        return `${hours} 小时 ${minutes % 60} 分钟`;
      }
      return `${minutes} 分钟`;
    };

    onMounted(() => {
      void refreshNodes();
    });

    return {
      nodeRecords,
      loadingNodes,
      syncingNodeKey,
      nodeMessage,
      refreshNodes,
      syncNode,
      formatDate,
      formatDuration
    };
  }
});
</script>

<style scoped>
.card-page {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}

.card {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}

.nested {
  margin-top: 16px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.panel-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}

.subtitle,
.muted,
.address-text,
.error-text,
.empty-state {
  color: #475569;
}

.node-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.node-card {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  background: #fff;
}

.node-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  align-items: center;
}

.node-card-head strong {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.node-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.node-meta span {
  padding: 4px 8px;
  border-radius: 999px;
  background: #f1f5f9;
  font-size: 12px;
}

button {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  cursor: pointer;
}

button.secondary,
.sync-button {
  background: #0f766e;
}

.sync-button {
  flex-shrink: 0;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.status {
  margin-top: 8px;
  color: #333;
}

.address-text,
.error-text {
  margin: 0;
  word-break: break-all;
}
</style>
