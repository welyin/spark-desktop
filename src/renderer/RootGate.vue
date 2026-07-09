<template>
  <section class="root-gate">
    <App v-if="showApp" />

    <el-card v-else class="gate-card" shadow="never" v-loading="authBusy" element-loading-text="正在登录...">
      <template #header>
        <div>
          <h1>账号入口</h1>
          <p class="desc">登录前不展示主界面，请先完成 RootID 注册 / 登录。</p>
        </div>
      </template>

      <el-descriptions :column="1" border>
        <el-descriptions-item label="是否已注册">{{ rootStatus.initialized ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="是否已登录">{{ rootStatus.unlocked ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="RootID">{{ rootStatus.rootId || '未创建' }}</el-descriptions-item>
      </el-descriptions>

      <div class="auth-wrap">
        <RegisterPage v-if="!rootStatus.initialized" @register="handleRegister" />
        <LoginPage v-else-if="!rootStatus.unlocked" :busy="authBusy" @login="handleLogin" />

        <div v-else class="ready-actions">
          <el-button type="primary" @click="showApp = true">进入主界面</el-button>
          <el-button type="danger" plain @click="handleLogout">退出登录</el-button>
        </div>
      </div>

      <el-alert v-if="message" :title="message" type="info" :closable="false" show-icon />
      <el-alert v-if="mnemonicNotice" :title="mnemonicNotice" type="warning" :closable="false" show-icon />
    </el-card>
  </section>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue';
import App from './App.vue';
import RegisterPage from './pages/auth/RegisterPage.vue';
import LoginPage from './pages/auth/LoginPage.vue';

type RootStatus = {
  initialized: boolean;
  unlocked: boolean;
  rootId: string | null;
};

export default defineComponent({
  name: 'RootGate',
  components: {
    App,
    RegisterPage,
    LoginPage
  },
  setup() {
    const rootStatus = ref<RootStatus>({ initialized: false, unlocked: false, rootId: null });
    const showApp = ref(false);
    const authBusy = ref(false);
    const message = ref('');
    const mnemonicNotice = ref('');

    const refreshStatus = async () => {
      rootStatus.value = await window.electronAPI.rootIdentity.status();
      showApp.value = rootStatus.value.initialized && rootStatus.value.unlocked;
    };

    const handleRegister = async (password: string) => {
      try {
        const result = await window.electronAPI.rootIdentity.initialize(password);
        mnemonicNotice.value = `助记词（仅展示一次，请离线保存）：${result.mnemonic}`;
        message.value = `注册成功，RootID=${result.rootId}`;
        await refreshStatus();
      } catch (error) {
        message.value = `注册失败：${error}`;
      }
    };

    const handleLogin = async (password: string) => {
      authBusy.value = true;
      try {
        const result = await window.electronAPI.rootIdentity.unlock(password);
        message.value = `登录成功，RootID=${result.rootId}`;
        rootStatus.value = {
          initialized: true,
          unlocked: true,
          rootId: result.rootId
        };
        showApp.value = true;
        void refreshStatus();
      } catch (error) {
        message.value = `登录失败：${error}`;
      } finally {
        authBusy.value = false;
      }
    };

    const handleLogout = async () => {
      try {
        await window.electronAPI.rootIdentity.lock();
        showApp.value = false;
        await refreshStatus();
      } catch (error) {
        message.value = `退出失败：${error}`;
      }
    };

    onMounted(async () => {
      await refreshStatus();
    });

    return {
      rootStatus,
      showApp,
      authBusy,
      message,
      mnemonicNotice,
      handleRegister,
      handleLogin,
      handleLogout
    };
  }
});
</script>

<style scoped>
.root-gate {
  min-height: 100vh;
  padding: 16px;
  box-sizing: border-box;
  background: #f5f7fa;
}

.gate-card {
  max-width: 820px;
  margin: 0 auto;
}

h1 {
  margin: 0;
}

.desc {
  margin: 8px 0 0;
  color: #64748b;
}

.auth-wrap {
  margin: 16px 0;
}

.ready-actions {
  display: flex;
  gap: 12px;
  margin: 8px 0;
}
</style>
