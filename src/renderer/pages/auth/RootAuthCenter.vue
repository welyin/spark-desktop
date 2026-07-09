<template>
  <section class="card-page">
    <h1>我的</h1>
    <p>账号登录前不会显示主界面，先完成 RootID 注册 / 登录。</p>

    <div class="status-grid">
      <div class="status-item"><strong>是否已注册：</strong>{{ rootStatus.initialized ? '是' : '否' }}</div>
      <div class="status-item"><strong>是否已登录：</strong>{{ rootStatus.unlocked ? '是' : '否' }}</div>
      <div class="status-item"><strong>RootID：</strong>{{ rootStatus.rootId || '未创建' }}</div>
    </div>

    <div class="section-wrap">
      <RegisterPage v-if="!rootStatus.initialized" @register="handleRegister" />
      <LoginPage v-else-if="!rootStatus.unlocked" @login="handleLogin" />

      <section v-else class="card-section">
        <h2>已登录</h2>
        <div class="row">
          <button @click="openRootPage">RootID</button>
          <button class="warn" @click="handleLogout">退出登录</button>
        </div>
      </section>
    </div>

    <p class="message">{{ message }}</p>
    <p v-if="mnemonicNotice" class="secret-notice">{{ mnemonicNotice }}</p>
  </section>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue';
import RegisterPage from './RegisterPage.vue';
import LoginPage from './LoginPage.vue';

type RootStatus = {
  initialized: boolean;
  unlocked: boolean;
  rootId: string | null;
};

export default defineComponent({
  name: 'RootAuthCenter',
  components: {
    RegisterPage,
    LoginPage
  },
  emits: ['open-root-page', 'update-auth-state'],
  setup(_, { emit }) {
    const rootStatus = ref<RootStatus>({ initialized: false, unlocked: false, rootId: null });
    const message = ref('');
    const mnemonicNotice = ref('');

    const refreshStatus = async () => {
      rootStatus.value = await window.electronAPI.rootIdentity.status();
      emit('update-auth-state', rootStatus.value);
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
      try {
        const result = await window.electronAPI.rootIdentity.unlock(password);
        message.value = `登录成功，RootID=${result.rootId}`;
        await refreshStatus();
      } catch (error) {
        message.value = `登录失败：${error}`;
      }
    };

    const handleLogout = async () => {
      try {
        await window.electronAPI.rootIdentity.lock();
        message.value = '已退出登录';
        await refreshStatus();
      } catch (error) {
        message.value = `退出失败：${error}`;
      }
    };

    const openRootPage = () => {
      emit('open-root-page');
    };

    onMounted(async () => {
      await refreshStatus();
    });

    return {
      rootStatus,
      message,
      mnemonicNotice,
      handleRegister,
      handleLogin,
      handleLogout,
      openRootPage
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

.section-wrap {
  margin-top: 14px;
}

.card-section {
  padding: 14px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
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

.secret-notice {
  margin-top: 8px;
  padding: 10px;
  border-radius: 8px;
  background: #fff7ed;
  color: #9a3412;
  word-break: break-word;
}
</style>
