<template>
  <section class="card-page">
    <template v-if="!rootStatus.initialized || !rootStatus.unlocked">
      <h1>我的</h1>
      <p>账号登录前不会显示主界面，先完成 RootID 注册 / 登录。</p>
      <RootAuthCenter @open-root-page="showRootPage = true" @update-auth-state="syncAuthState" />
    </template>

    <template v-else>
      <h1>我的</h1>
      <p>RootID 已就绪，可将下方信息发给组织管理员用于添加成员。</p>

      <section v-if="!showRootPage" class="card-section">
        <div class="status-grid">
          <div class="status-item"><strong>RootID：</strong>{{ rootStatus.rootId || '未创建' }}</div>
          <div class="status-item"><strong>状态：</strong>已登录</div>
          <div class="status-item"><strong>P2P 初始化：</strong>{{ p2pInfo.initialized ? '是' : '否' }}</div>
          <div class="status-item"><strong>P2P 运行中：</strong>{{ p2pInfo.started ? '是' : '否' }}</div>
          <div class="status-item"><strong>PeerId：</strong>{{ p2pInfo.peerId || '未获取' }}</div>
          <div class="status-item">
            <strong>已连接 Peer：</strong>
            <template v-if="p2pInfo.connectedPeers.length > 0">
              <div v-for="peer in p2pInfo.connectedPeers" :key="peer" class="mono">{{ peer }}</div>
            </template>
            <span v-else>暂无</span>
          </div>
          <div class="status-item">
            <strong>spark-sync 订阅者：</strong>
            <template v-if="p2pInfo.sparkSyncSubscribers.length > 0">
              <div v-for="peer in p2pInfo.sparkSyncSubscribers" :key="`sub-${peer}`" class="mono">{{ peer }}</div>
            </template>
            <span v-else>暂无</span>
          </div>
          <div v-if="p2pInfo.error" class="status-item warn-item"><strong>P2P 启动异常：</strong>{{ p2pInfo.error }}</div>
          <div class="status-item">
            <strong>节点地址：</strong>
            <template v-if="p2pInfo.addresses.length > 0">
              <div v-for="addr in p2pInfo.addresses" :key="addr" class="mono">{{ addr }}</div>
            </template>
            <span v-else>未获取（可能仍在启动或未监听可拨号地址）</span>
          </div>
        </div>

        <section class="card-section share-card">
          <h2>成员添加资料</h2>
          <p class="hint">管理员添加你为成员时需要 RootID 与节点信息。</p>
          <pre class="share-block">{{ shareText }}</pre>
          <div class="row">
            <button @click="copyShareText">复制资料</button>
            <button @click="refreshNodeInfo">刷新节点信息</button>
          </div>
        </section>

        <div class="row">
          <button @click="showRootPage = true">RootID</button>
          <button class="warn" @click="handleLogout">退出登录</button>
        </div>
        <p class="message">{{ message }}</p>
      </section>

      <RootIDPage v-else @logout="handleLogout" />
    </template>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue';
import RootAuthCenter from './auth/RootAuthCenter.vue';
import RootIDPage from './RootIDPage.vue';

type RootStatus = {
  initialized: boolean;
  unlocked: boolean;
  rootId: string | null;
};

type P2PInfo = {
  initialized: boolean;
  started: boolean;
  peerId: string | null;
  addresses: string[];
  connectedPeers: string[];
  sparkSyncSubscribers: string[];
  error?: string | null;
};

export default defineComponent({
  name: 'MinePage',
  components: {
    RootAuthCenter,
    RootIDPage
  },
  setup() {
    const rootStatus = ref<RootStatus>({ initialized: false, unlocked: false, rootId: null });
    const showRootPage = ref(false);
    const message = ref('');
    const p2pInfo = ref<P2PInfo>({ initialized: false, started: false, peerId: null, addresses: [], connectedPeers: [], sparkSyncSubscribers: [], error: null });

    const refreshStatus = async () => {
      rootStatus.value = await window.electronAPI.rootIdentity.status();
    };

    const refreshNodeInfo = async () => {
      try {
        p2pInfo.value = await window.electronAPI.p2p.info();
        if (!p2pInfo.value.started || p2pInfo.value.addresses.length === 0) {
          // 主进程启动 libp2p 需要一定时间，这里做一次短暂重试提升首屏可见性。
          setTimeout(async () => {
            try {
              p2pInfo.value = await window.electronAPI.p2p.info();
            } catch {
              // Ignore retry error, keep previous state/error.
            }
          }, 1200);
        }
      } catch (error) {
        message.value = `读取 P2P 信息失败：${error}`;
      }
    };

    const shareText = computed(() => {
      const addressesText = p2pInfo.value.addresses.length > 0
        ? p2pInfo.value.addresses.join('\n')
        : '未获取';

      return [
        `RootID: ${rootStatus.value.rootId || '未创建'}`,
        `PeerId: ${p2pInfo.value.peerId || '未获取'}`,
        'P2P Addresses:',
        addressesText
      ].join('\n');
    });

    const copyShareText = async () => {
      try {
        await navigator.clipboard.writeText(shareText.value);
        message.value = '成员添加资料已复制';
      } catch (error) {
        message.value = `复制失败：${error}`;
      }
    };

    const handleLogout = async () => {
      try {
        await window.electronAPI.rootIdentity.lock();
        showRootPage.value = false;
        message.value = '';
        p2pInfo.value = { initialized: false, started: false, peerId: null, addresses: [], connectedPeers: [], sparkSyncSubscribers: [], error: null };
        await refreshStatus();
      } catch (error) {
        console.warn('退出失败', error);
      }
    };

    const syncAuthState = (status: RootStatus) => {
      rootStatus.value = status;
      if (!status.unlocked) {
        showRootPage.value = false;
      }
    };

    onMounted(async () => {
      try {
        await refreshStatus();
        await refreshNodeInfo();
      } catch (error) {
        message.value = `读取状态失败：${error}`;
      }
    });

    return {
      rootStatus,
      showRootPage,
      p2pInfo,
      message,
      shareText,
      copyShareText,
      refreshNodeInfo,
      handleLogout,
      syncAuthState
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

.card-section {
  padding: 14px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}

.status-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.status-item {
  padding: 8px;
  border-radius: 6px;
  background: #f7fafc;
}

.warn-item {
  background: #fff7ed;
  color: #9a3412;
}

.mono {
  margin-top: 4px;
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: #0f172a;
  word-break: break-all;
}

.share-card {
  margin-top: 12px;
  background: #f8fafc;
}

.share-block {
  margin: 8px 0;
  padding: 10px;
  border-radius: 8px;
  background: #111827;
  color: #e5e7eb;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.hint {
  margin: 0;
  color: #4b5563;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
  align-items: center;
}

button {
  padding: 9px 14px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.warn {
  background: #b91c1c;
}

.message {
  margin-top: 12px;
  color: #1f2937;
}
</style>
