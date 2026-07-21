<template>
  <el-card>
    <template #header>
      <div>
        <h2>切换用户</h2>
        <p class="hint">选择本设备上登录过的账号，或注册新用户。</p>
      </div>
    </template>

    <el-table :data="identities" v-loading="loading" empty-text="本设备还没有任何账号">
      <el-table-column label="RootID">
        <template #default="{ row }">
          <span class="mono">{{ row.rootId }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">
          {{ formatTime(row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column width="150" fixed="right">
        <template #default="{ row }">
          <el-tag v-if="row.active" type="success" size="small">当前账号</el-tag>
          <el-button v-else type="primary" link @click="emit('select', row.rootId)">登录此账号</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="row">
      <el-button type="primary" @click="emit('register')">注册新用户</el-button>
      <el-button link type="info" @click="emit('back')">返回登录</el-button>
    </div>
  </el-card>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue';

type IdentityItem = {
  rootId: string;
  createdAt: number;
  active: boolean;
};

export default defineComponent({
  name: 'SwitchUserPage',
  emits: ['select', 'register', 'back'],
  setup(_, { emit }) {
    const identities = ref<IdentityItem[]>([]);
    const loading = ref(false);

    const formatTime = (ts: number) => {
      if (!ts) {
        return '-';
      }
      return new Date(ts).toLocaleString();
    };

    onMounted(async () => {
      loading.value = true;
      try {
        identities.value = await window.electronAPI.rootIdentity.listIdentities();
      } finally {
        loading.value = false;
      }
    });

    return {
      identities,
      loading,
      formatTime,
      emit
    };
  }
});
</script>

<style scoped>
h2 {
  margin: 0;
}

.hint {
  margin: 6px 0 0;
  color: #64748b;
}

.mono {
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
  word-break: break-all;
}

.row {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 14px;
}
</style>
