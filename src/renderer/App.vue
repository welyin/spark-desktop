<template>
  <div>
    <section v-if="isPluginViewMode" class="card plugin-host">
      <h1>插件独立视图</h1>
      <p><strong>域：</strong>{{ pluginWindowDomain }}</p>
      <p><strong>视图：</strong>{{ pluginWindowView }}</p>
      <p v-if="pluginHostMessage">{{ pluginHostMessage }}</p>
      <component v-if="activePluginView" :is="activePluginView" />
    </section>

    <template v-else>
      <div class="shell">
        <aside class="tabbar">
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'affairs' }"
            @click="activeTab = 'affairs'"
          >
            <span class="tab-icon">事</span>
            事务
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'org' }"
            @click="activeTab = 'org'"
          >
            <span class="tab-icon">组</span>
            组织
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'apps' }"
            @click="activeTab = 'apps'"
          >
            <span class="tab-icon">应</span>
            应用
          </button>

          <button
            class="tab-btn"
            :class="{ active: activeTab === 'test' }"
            @click="activeTab = 'test'"
          >
            <span class="tab-icon">测</span>
            测试
          </button>

          <button
            v-for="tab in pluginTabs"
            :key="tab.id"
            class="tab-btn plugin"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            <span class="tab-icon">{{ tab.icon }}</span>
            {{ tab.title }}
          </button>

          <button
            class="tab-btn mine"
            :class="{ active: activeTab === 'mine' }"
            @click="activeTab = 'mine'"
          >
            <span class="tab-icon">我</span>
            我的
          </button>
        </aside>

        <main class="page-panel">
          <AffairsPage v-if="activeTab === 'affairs'" />
          <OrgPage v-else-if="activeTab === 'org'" />
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

          <section v-else-if="activePluginTab" class="card">
            <div class="plugin-tab-header">
              <h1>{{ activePluginTab.title }}</h1>
              <p>{{ activePluginTab.pluginDomain }} / {{ activePluginTab.pluginView }}</p>
            </div>
            <component v-if="activePluginComponent" :is="activePluginComponent" />
            <p v-else class="status">未找到插件视图：{{ activePluginTab.pluginDomain }} / {{ activePluginTab.pluginView }}</p>
          </section>
        </main>
      </div>
    </template>
  </div>
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

    const activePluginComponent = computed<Component | null>(() => {
      if (!activePluginTab.value) {
        return null;
      }
      return getPluginView(activePluginTab.value.pluginDomain, activePluginTab.value.pluginView);
    });

    const openPluginTab = (payload: OpenPluginTabPayload) => {
      const pluginDomain = payload.pluginDomain.trim();
      const pluginView = payload.pluginView.trim() || 'default';
      if (!pluginDomain.startsWith('plugin:')) {
        resultMessage.value = `无效插件域：${pluginDomain}`;
        return;
      }

      const tabId = `plugin|${pluginDomain}|${pluginView}`;
      const existing = pluginTabs.value.find((item) => item.id === tabId);
      if (!existing) {
        pluginTabs.value.push({
          id: tabId,
          pluginDomain,
          pluginView,
          title: payload.title || `${pluginDomain}/${pluginView}`,
          icon: payload.icon || 'P'
        });
      }
      activeTab.value = tabId;
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
      activePluginComponent,
      dbStatus,
      dbPath,
      resultMessage,
      openDb,
      closeDb,
      putValue,
      getValue,
      delValue,
      batchOps,
      openPluginTab
    };
  }
});
</script>

<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
  padding: 0;
  margin: 0;
  background: #f2f4f8;
}

.card {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}

.shell {
  display: flex;
  min-height: 100vh;
}

.tabbar {
  position: fixed;
  inset: 0 auto 0 0;
  width: 164px;
  background: #0f172a;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  z-index: 10;
}

.tab-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
}

.tab-icon {
  width: 22px;
  height: 22px;
  border-radius: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.18);
  font-size: 12px;
}

.tab-btn.active {
  background: #16a34a;
  border-color: #16a34a;
  color: #fff;
}

.tab-btn.mine {
  margin-top: auto;
  align-self: flex-end;
}

.tab-btn.plugin {
  background: rgba(34, 197, 94, 0.14);
}

.page-panel {
  flex: 1;
  margin-left: 164px;
  padding: 20px;
  min-width: 0;
}

.nested {
  margin-top: 16px;
}

.plugin-tab-header {
  margin-bottom: 12px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

input {
  margin-left: 8px;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
}

button {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.status {
  margin-top: 8px;
  color: #333;
}

.plugin-host {
  margin: 16px;
}

@media (max-width: 900px) {
  .shell {
    flex-direction: column;
  }

  .tabbar {
    position: static;
    width: auto;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    overflow-y: visible;
  }

  .page-panel {
    margin-left: 0;
  }

  .tab-btn.mine {
    margin-top: 0;
    margin-left: auto;
  }
}
</style>
