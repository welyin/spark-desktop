<template>
  <section class="card-section">
    <h2>用户注册</h2>
    <p>首次注册将创建 RootID（仅本地存储）。</p>

    <div class="row">
      <label>
        登录密码
        <input v-model="password" type="password" placeholder="至少 8 位" />
      </label>
      <label>
        确认密码
        <input v-model="confirmPassword" type="password" placeholder="重复输入密码" />
      </label>
    </div>

    <div class="row">
      <button @click="submit" :disabled="busy">创建 RootID</button>
    </div>

    <p class="hint">{{ message }}</p>
  </section>
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
}

input {
  margin-left: 8px;
  padding: 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}

button {
  padding: 9px 14px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.hint {
  margin-top: 10px;
  color: #4b5563;
}
</style>
