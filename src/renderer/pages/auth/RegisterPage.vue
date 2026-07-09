<template>
  <el-card>
    <template #header>
      <div>
        <h2>用户注册</h2>
        <p class="hint">首次注册将创建 RootID（仅本地存储）。</p>
      </div>
    </template>

    <el-form label-position="top">
      <el-form-item label="登录密码">
        <el-input v-model="password" type="password" show-password placeholder="至少 8 位" :disabled="busy" />
      </el-form-item>
      <el-form-item label="确认密码">
        <el-input v-model="confirmPassword" type="password" show-password placeholder="重复输入密码" :disabled="busy" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="submit" :loading="busy" :disabled="busy">创建 RootID</el-button>
      </el-form-item>
    </el-form>

    <el-alert v-if="message" :title="message" type="info" :closable="false" show-icon />
  </el-card>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';

export default defineComponent({
  name: 'RegisterPage',
  emits: ['register'],
  setup(_, { emit }) {
    const password = ref('');
    const confirmPassword = ref('');
    const busy = ref(false);
    const message = ref('');

    const submit = async () => {
      if (password.value.length < 8) {
        message.value = '密码至少 8 位';
        return;
      }
      if (password.value !== confirmPassword.value) {
        message.value = '两次密码不一致';
        return;
      }

      busy.value = true;
      message.value = '';
      try {
        emit('register', password.value);
      } finally {
        busy.value = false;
      }
    };

    return {
      password,
      confirmPassword,
      busy,
      message,
      submit
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
</style>
