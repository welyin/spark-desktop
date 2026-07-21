<template>
  <el-card>
    <template #header>
      <div>
        <h2>用户登录</h2>
        <p class="hint">登录会解锁 RootID，用于签名与授权。</p>
      </div>
    </template>

    <el-form label-position="top">
      <el-form-item v-if="rootId" label="当前账号">
        <div class="current-account mono">{{ rootId }}</div>
      </el-form-item>
      <el-form-item label="登录密码">
        <el-input v-model="password" type="password" show-password placeholder="输入注册密码" :disabled="busy" @keyup.enter="submit" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="submit" :loading="busy" :disabled="busy">解锁 RootID</el-button>
        <el-button @click="emit('switch')" :disabled="busy">切换用户</el-button>
      </el-form-item>
    </el-form>

    <el-alert v-if="message" :title="message" type="info" :closable="false" show-icon />
  </el-card>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';

export default defineComponent({
  name: 'LoginPage',
  props: {
    busy: {
      type: Boolean,
      default: false
    },
    rootId: {
      type: String,
      default: null
    }
  },
  emits: ['login', 'switch'],
  setup(props, { emit }) {
    const password = ref('');
    const message = ref('');

    const submit = async () => {
      if (!password.value) {
        message.value = '请输入密码';
        return;
      }

      if (props.busy) {
        return;
      }

      message.value = '';
      emit('login', password.value);
    };

    return {
      password,
      message,
      submit,
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

.current-account {
  word-break: break-all;
  color: #334155;
}

.mono {
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
}
</style>
