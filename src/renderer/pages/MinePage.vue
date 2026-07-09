<template>
  <section class="card-page">
    <template v-if="!rootStatus.initialized || !rootStatus.unlocked">
      <h1>我的</h1>
      <p>账号登录前不会显示主界面，先完成 RootID 注册 / 登录。</p>
      <RootAuthCenter @open-root-page="showRootPage = true" @update-auth-state="syncAuthState" />
    </template>

    <template v-else>
      <h1>我的</h1>
      <p>RootID 已就绪</p>

      <section v-if="!showRootPage" class="card-section">
        <div class="status-grid">
          <div class="status-item"><strong>RootID：</strong>{{ rootStatus.rootId || '未创建' }}</div>
          <div class="status-item"><strong>状态：</strong>已登录</div>
        </div>
        <div class="row">
          <button @click="showRootPage = true">RootID</button>
          <button class="warn" @click="handleLogout">退出登录</button>
        </div>
      </section>

      <RootIDPage v-else @logout="handleLogout" />
    </template>
  </section>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue';
import RootAuthCenter from './auth/RootAuthCenter.vue';
import RootIDPage from './RootIDPage.vue';

type RootStatus = {
  initialized: boolean;
  unlocked: boolean;
  rootId: string | null;
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

    const refreshStatus = async () => {
      rootStatus.value = await window.electronAPI.rootIdentity.status();
    };

    const handleLogout = async () => {
      try {
        await window.electronAPI.rootIdentity.lock();
        showRootPage.value = false;
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
      } catch (error) {
        message.value = `读取状态失败：${error}`;
      }
    });

    return {
      rootStatus,
      showRootPage,
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
