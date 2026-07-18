<template>
  <section v-if="isPluginViewMode" class="plugin-host-wrap">
    <el-card shadow="never">
      <el-alert v-if="pluginHostMessage" :title="pluginHostMessage" type="warning" :closable="false" show-icon />
      <component v-if="activePluginView" :is="activePluginView" />
    </el-card>
  </section>

  <el-container v-else class="shell">
    <el-aside width="210px" class="side">
      <el-menu :default-active="activeTab" class="menu" @select="handleMenuSelect">
        <el-menu-item index="affairs">事务</el-menu-item>
        <el-menu-item index="org">组织</el-menu-item>
        <el-menu-item index="apps">应用</el-menu-item>
        <el-menu-item index="test">测试</el-menu-item>
        <el-menu-item v-for="tab in pluginTabs" :key="tab.id" :index="tab.id">
          {{ tab.icon }} {{ tab.title }}
        </el-menu-item>
        <el-menu-item index="mine" class="mine-entry">我的</el-menu-item>
      </el-menu>
    </el-aside>

    <el-main class="main">
      <AffairsPage v-if="activeTab === 'affairs'" />
      <OrgPage v-else-if="activeTab === 'org'" @open-plugin-tab="openPluginTab" />
      <AppsPage v-else-if="activeTab === 'apps'" @open-plugin-tab="openPluginTab" />
      <TestPage
        v-else-if="activeTab === 'test'"
        :db-status="dbStatus"
        :db-path="dbPath"
        :result-message="resultMessage"
        @open-db="openDb"
        @close-db="closeDb"
        @put-value="putValue"
        @get-value="getValue"
        @del-value="delValue"
        @batch-ops="batchOps"
      />
      <MinePage v-else-if="activeTab === 'mine'" />

      <el-card v-else-if="activePluginTab" shadow="never" class="plugin-tab-card">
        <template #header>
          <div class="plugin-tab-header-bar">
            <div class="plugin-tab-header-left">
              <el-button text type="primary" @click="goBackFromPlugin">&lt; 返回</el-button>
            </div>
            <div class="plugin-tab-header-center">
              <h1>{{ activePluginTab.title }}</h1>
              <p>{{ activePluginTab.pluginDomain }} / {{ activePluginTab.pluginView }}</p>
            </div>
            <div class="plugin-tab-header-right" />
          </div>
        </template>
        <iframe
          class="plugin-frame"
          :src="pluginFrameSrc"
          :title="`${activePluginTab.pluginDomain}/${activePluginTab.pluginView}`"
        />
      </el-card>
    </el-main>
  </el-container>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref, shallowRef, type Component } from 'vue';
import { getPluginView } from './plugin-view-registry';
import { registerDefaultPluginViews } from '../plugin-demo/register-default-plugin-views';
import AffairsPage from './pages/AffairsPage.vue';
import OrgPage from './pages/OrgPage.vue';
import AppsPage, { type OpenPluginTabPayload } from './pages/AppsPage.vue';
import TestPage from './pages/TestPage.vue';
import MinePage from './pages/MinePage.vue';

interface DbStatus {
  open: boolean;
}

type DbOperation = {
  type: 'put' | 'del';
  key: string;
  value?: string;
};

type PluginTab = {
  id: string;
  pluginDomain: string;
  pluginView: string;
  title: string;
  icon: string;
  sourceTab?: string;
  pluginContext?: {
    orgId?: string;
  };
};

export default defineComponent({
  name: 'App',
  components: {
    AffairsPage,
    OrgPage,
    AppsPage,
    TestPage,
    MinePage
  },
  setup() {
    registerDefaultPluginViews();

    const search = new URLSearchParams(window.location.search);
    const pluginWindowDomain = search.get('pluginDomain');
    const pluginWindowView = search.get('pluginView') ?? 'default';
    const isPluginViewMode = ref(Boolean(pluginWindowDomain));
    const activePluginView = shallowRef<Component | null>(null);
    const pluginHostMessage = ref('');

    const dbStatus = ref<DbStatus>({ open: false });
    const dbPath = ref('未初始化');
    const resultMessage = ref('无需操作');
    const activeTab = ref<string>('apps');
    const pluginTabs = ref<PluginTab[]>([]);

    const activePluginTab = computed(() => {
      return pluginTabs.value.find((tab) => tab.id === activeTab.value) ?? null;
    });

    const pluginFrameSrc = computed(() => {
      const tab = activePluginTab.value;
      if (!tab) {
        return '';
      }

      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('pluginDomain', tab.pluginDomain);
      url.searchParams.set('pluginView', tab.pluginView);
      if (tab.pluginContext?.orgId) {
        url.searchParams.set('orgId', tab.pluginContext.orgId);
      }
      return url.toString();
    });

    const handleMenuSelect = (index: string) => {
      activeTab.value = index;
    };

    const openPluginTab = (payload: OpenPluginTabPayload) => {
      const pluginDomain = payload.pluginDomain.trim();
      const pluginView = payload.pluginView.trim() || 'default';
      if (!pluginDomain.startsWith('plugin:')) {
        resultMessage.value = `无效插件域：${pluginDomain}`;
        return;
      }

      const pluginContext = payload.pluginContext;
      const contextSuffix = pluginContext?.orgId ? `|${pluginContext.orgId}` : '';

      const tabId = `plugin|${pluginDomain}|${pluginView}${contextSuffix}`;
      const existing = pluginTabs.value.find((item) => item.id === tabId);
      if (!existing) {
        const sourceTab = activeTab.value.startsWith('plugin|') ? 'org' : activeTab.value;
        pluginTabs.value.push({
          id: tabId,
          pluginDomain,
          pluginView,
          title: payload.title || `${pluginDomain}/${pluginView}`,
          icon: payload.icon || 'P',
          sourceTab,
          pluginContext
        });
      }
      activeTab.value = tabId;
    };

    const goBackFromPlugin = () => {
      const tab = activePluginTab.value;
      const fallback = 'org';
      activeTab.value = tab?.sourceTab ?? fallback;
    };

    const updateStatus = async () => {
      try {
        const status = await window.electronAPI.db.status();
        dbStatus.value = status;
      } catch (error) {
        resultMessage.value = `读取状态失败：${error}`;
      }
    };

    const openDb = async () => {
      try {
        const result = await window.electronAPI.db.open();
        dbStatus.value.open = result.open;
        dbPath.value = result.path;
        resultMessage.value = `已打开数据库：${result.path}`;
      } catch (error) {
        resultMessage.value = `打开失败：${error}`;
      }
    };

    const closeDb = async () => {
      try {
        const result = await window.electronAPI.db.close();
        dbStatus.value.open = result.open;
        resultMessage.value = '数据库已关闭';
      } catch (error) {
        resultMessage.value = `关闭失败：${error}`;
      }
    };

    const putValue = async () => {
      try {
        await window.electronAPI.db.put('spark-key', 'spark-value');
        resultMessage.value = 'Put 成功：spark-key -> spark-value';
      } catch (error) {
        resultMessage.value = `Put 失败：${error}`;
      }
    };

    const getValue = async () => {
      try {
        const value = await window.electronAPI.db.get('spark-key');
        resultMessage.value = value === null ? '未找到 spark-key' : `Get 成功：${value}`;
      } catch (error) {
        resultMessage.value = `Get 失败：${error}`;
      }
    };

    const delValue = async () => {
      try {
        await window.electronAPI.db.del('spark-key');
        resultMessage.value = 'Del 成功：spark-key 已删除';
      } catch (error) {
        resultMessage.value = `Del 失败：${error}`;
      }
    };

    const batchOps = async () => {
      try {
        const operations: DbOperation[] = [
          { type: 'put', key: 'batch-1', value: 'value-1' },
          { type: 'put', key: 'batch-2', value: 'value-2' },
          { type: 'del', key: 'spark-key' }
        ];
        await window.electronAPI.db.batch(operations);
        resultMessage.value = 'Batch 操作完成';
      } catch (error) {
        resultMessage.value = `Batch 失败：${error}`;
      }
    };

    onMounted(() => {
      if (isPluginViewMode.value && pluginWindowDomain) {
        const view = getPluginView(pluginWindowDomain, pluginWindowView);
        if (view) {
          activePluginView.value = view;
        } else {
          pluginHostMessage.value = `未找到插件视图：${pluginWindowDomain} / ${pluginWindowView}`;
        }
        return;
      }

      updateStatus();
    });

    return {
      isPluginViewMode,
      pluginWindowDomain,
      pluginWindowView,
      activePluginView,
      pluginHostMessage,
      activeTab,
      pluginTabs,
      activePluginTab,
      pluginFrameSrc,
      dbStatus,
      dbPath,
      resultMessage,
      handleMenuSelect,
      openDb,
      closeDb,
      putValue,
      getValue,
      delValue,
      batchOps,
      openPluginTab,
      goBackFromPlugin
    };
  }
});
</script>

<style>
body {
  margin: 0;
  background: #f5f7fa;
}

.shell {
  min-height: 100vh;
  display: block;
}

.side {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 20;
  border-right: 1px solid var(--el-border-color);
  background: #fff;
  overflow-y: auto;
}

.menu {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.mine-entry {
  margin-top: auto;
}

.main {
  margin-left: 210px;
  min-height: 100vh;
  box-sizing: border-box;
  padding: 0;
}

.el-main {
  padding: 0 !important;
}

.plugin-host-wrap {
  padding: 0;
}

.plugin-tab-header h1 {
  margin: 0;
}

.plugin-tab-header p {
  margin: 8px 0 0;
  color: #64748b;
}

.plugin-tab-card {
  height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
}

.plugin-tab-card .el-card__header {
  flex-shrink: 0;
}

.plugin-tab-card .el-card__body {
  flex: 1;
  padding: 0;
  min-height: 0;
}

.plugin-tab-header-bar {
  display: grid;
  grid-template-columns: 120px 1fr 120px;
  align-items: center;
}

.plugin-tab-header-left {
  display: flex;
  justify-content: flex-start;
}

.plugin-tab-header-center {
  text-align: center;
}

.plugin-tab-header-center h1 {
  margin: 0;
}

.plugin-tab-header-center p {
  margin: 8px 0 0;
  color: #64748b;
}

.plugin-tab-header-right {
  min-height: 1px;
}

.plugin-frame {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 10px;
  background: #fff;
  display: block;
}

@media (max-width: 900px) {
  .side {
    width: 170px !important;
  }

  .main {
    margin-left: 170px;
  }
}
</style>
