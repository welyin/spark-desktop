<template>
  <section class="mine-page">
    <el-card shadow="never">
      <template #header>
        <h1>我的</h1>
      </template>

      <template v-if="!rootStatus.initialized || !rootStatus.unlocked">
        <p class="lede">账号登录前不会显示主界面，先完成 RootID 注册 / 登录。</p>
        <RootAuthCenter @open-root-page="showRootPage = true" @update-auth-state="syncAuthState" />
      </template>

      <template v-else>
        <p class="lede">RootID 已就绪，可将下方信息发给组织管理员用于添加成员。</p>

        <section v-if="!showRootPage" class="content-section">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="RootID">{{ rootStatus.rootId || '未创建' }}</el-descriptions-item>
            <el-descriptions-item label="状态">已登录</el-descriptions-item>
            <el-descriptions-item label="P2P 初始化">{{ p2pInfo.initialized ? '是' : '否' }}</el-descriptions-item>
            <el-descriptions-item label="P2P 运行中">{{ p2pInfo.started ? '是' : '否' }}</el-descriptions-item>
            <el-descriptions-item label="PeerId">{{ p2pInfo.peerId || '未获取' }}</el-descriptions-item>
            <el-descriptions-item label="已连接 Peer">
              <template v-if="p2pInfo.connectedPeers.length > 0">
                <div v-for="peer in p2pInfo.connectedPeers" :key="peer" class="mono">{{ peer }}</div>
              </template>
              <span v-else>暂无</span>
            </el-descriptions-item>
            <el-descriptions-item label="spark-sync 订阅者">
              <template v-if="p2pInfo.sparkSyncSubscribers.length > 0">
                <div v-for="peer in p2pInfo.sparkSyncSubscribers" :key="`sub-${peer}`" class="mono">{{ peer }}</div>
              </template>
              <span v-else>暂无</span>
            </el-descriptions-item>
            <el-descriptions-item label="节点地址">
              <template v-if="p2pInfo.addresses.length > 0">
                <div v-for="addr in p2pInfo.addresses" :key="addr" class="mono">{{ addr }}</div>
              </template>
              <span v-else>未获取（可能仍在启动或未监听可拨号地址）</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="p2pInfo.error"
            :title="`P2P 启动异常：${p2pInfo.error}`"
            type="warning"
            :closable="false"
            show-icon
            class="block-gap"
          />

          <el-card shadow="never" class="share-card">
            <template #header>
              <h2>成员添加资料</h2>
            </template>
            <p class="hint">管理员添加你为成员时需要 RootID 与节点信息。</p>
            <pre class="share-block">{{ shareText }}</pre>
            <div class="row">
              <el-button type="primary" @click="copyShareText">复制资料</el-button>
              <el-button @click="refreshNodeInfo">刷新节点信息</el-button>
            </div>
          </el-card>

          <el-card shadow="never" class="share-card">
            <template #header>
              <h2>数据管理</h2>
            </template>
            <p class="hint">容灾由组织 K 副本网络承担；此处提供用量可见、过期状态清理与手动导出转移。</p>

            <template v-if="dataUsage">
              <el-descriptions :column="1" border class="block-gap">
                <el-descriptions-item
                  v-for="row in usageRows"
                  :key="row.key"
                  :label="row.label"
                >
                  {{ row.keys }} 条 · {{ formatBytes(row.bytes) }}
                </el-descriptions-item>
                <el-descriptions-item label="合计">
                  {{ dataUsage.totalKeys }} 条 · {{ formatBytes(dataUsage.totalBytes) }}
                </el-descriptions-item>
                <el-descriptions-item v-if="dataUsage.disk" label="磁盘可用">
                  {{ formatBytes(dataUsage.disk.freeBytes) }} / {{ formatBytes(dataUsage.disk.totalBytes) }}
                  （{{ Math.round(dataUsage.disk.freeRatio * 100) }}%）
                </el-descriptions-item>
              </el-descriptions>

              <el-alert
                v-if="dataUsage.warnings.diskLow"
                title="磁盘可用空间不足：请组织管理员尽快处理——增加磁盘、导出旧数据转移，或在组织详情中执行手动清理。"
                type="error"
                :closable="false"
                show-icon
                class="block-gap"
              />
              <el-alert
                v-else-if="dataUsage.warnings.usageExceeded"
                title="本地数据量较大：建议管理员导出旧数据转移后执行手动清理（组织详情 → 数据治理）。"
                type="warning"
                :closable="false"
                show-icon
                class="block-gap"
              />
            </template>
            <p v-else class="hint block-gap">用量统计加载中…</p>

            <div class="row">
              <el-button :loading="dataActionRunning" @click="runDataCleanup">立即清理</el-button>
              <el-button :loading="dataActionRunning" @click="exportData">导出数据</el-button>
              <el-button @click="refreshDataUsage">刷新用量</el-button>
            </div>
            <el-alert v-if="dataMessage" :title="dataMessage" type="info" :closable="false" show-icon class="block-gap" />
          </el-card>

          <div class="row">
            <el-button @click="showRootPage = true">RootID</el-button>
            <el-button type="danger" plain @click="handleLogout">退出登录</el-button>
          </div>
          <el-alert v-if="message" :title="message" type="info" :closable="false" show-icon class="block-gap" />
        </section>

        <RootIDPage v-else @logout="handleLogout" />
      </template>
    </el-card>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { DataUsageReportDto } from '../../main/preload';
import { formatBytes } from '../utils/format';
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

const USAGE_CLASS_LABELS: Array<{ key: keyof DataUsageReportDto['classes']; label: string }> = [
  { key: 'documents', label: '业务文档' },
  { key: 'indexes', label: '索引' },
  { key: 'syncMeta', label: '同步元数据' },
  { key: 'evidence', label: '存证链' },
  { key: 'organization', label: '组织' },
  { key: 'p2p', label: '网络状态' },
  { key: 'system', label: '系统' },
  { key: 'other', label: '其他' }
];

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
    const dataUsage = ref<DataUsageReportDto | null>(null);
    const dataMessage = ref('');
    const dataActionRunning = ref(false);

    const usageRows = computed(() =>
      USAGE_CLASS_LABELS.map((item) => ({
        key: item.key,
        label: item.label,
        keys: dataUsage.value?.classes[item.key]?.keys ?? 0,
        bytes: dataUsage.value?.classes[item.key]?.bytes ?? 0
      }))
    );

    const refreshDataUsage = async () => {
      try {
        dataUsage.value = await window.electronAPI.dataManagement.usage();
      } catch (error) {
        dataMessage.value = `读取用量失败：${error}`;
      }
    };

    const runDataCleanup = async () => {
      dataActionRunning.value = true;
      try {
        const result = await window.electronAPI.dataManagement.cleanupNow();
        dataMessage.value = `清理完成：tombstone ${result.tombstones} 条、节点记录 ${result.peerRecords} 条、同步记账 ${result.orgSyncStates} 条`;
        await refreshDataUsage();
      } catch (error) {
        dataMessage.value = `清理失败：${error}`;
      } finally {
        dataActionRunning.value = false;
      }
    };

    const exportData = async () => {
      dataActionRunning.value = true;
      try {
        const result = await window.electronAPI.dataManagement.exportData();
        dataMessage.value = result.cancelled
          ? '已取消导出'
          : `已导出 ${result.entries} 条数据（${formatBytes(result.bytes)}）到 ${result.path}`;
      } catch (error) {
        dataMessage.value = `导出失败：${error}`;
      } finally {
        dataActionRunning.value = false;
      }
    };

    const refreshStatus = async () => {
      rootStatus.value = await window.electronAPI.rootIdentity.status();
    };

    const refreshNodeInfo = async () => {
      try {
        p2pInfo.value = await window.electronAPI.p2p.info();
        if (!p2pInfo.value.started || p2pInfo.value.addresses.length === 0) {
          setTimeout(async () => {
            try {
              p2pInfo.value = await window.electronAPI.p2p.info();
            } catch {
              // Keep current p2p state on retry failure.
            }
          }, 1200);
        }
      } catch (error) {
        message.value = `读取 P2P 信息失败：${error}`;
        ElMessage.error(message.value);
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
        ElMessage.success(message.value);
      } catch (error) {
        message.value = `复制失败：${error}`;
        ElMessage.error(message.value);
      }
    };

    const handleLogout = async () => {
      try {
        await window.electronAPI.rootIdentity.lock();
        showRootPage.value = false;
        message.value = '';
        p2pInfo.value = { initialized: false, started: false, peerId: null, addresses: [], connectedPeers: [], sparkSyncSubscribers: [], error: null };
        await refreshStatus();
        ElMessage.success('已退出登录');
      } catch (error) {
        message.value = `退出失败：${error}`;
        ElMessage.error(message.value);
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
        await refreshDataUsage();
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
      syncAuthState,
      dataUsage,
      dataMessage,
      dataActionRunning,
      usageRows,
      formatBytes,
      refreshDataUsage,
      runDataCleanup,
      exportData
    };
  }
});
</script>

<style scoped>
.mine-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

h1,
h2 {
  margin: 0;
}

.lede {
  margin: 0;
  color: #64748b;
}

.content-section {
  margin-top: 14px;
}

.mono {
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
  word-break: break-all;
}

.share-card {
  margin-top: 16px;
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

.block-gap {
  margin-top: 12px;
}
</style>
