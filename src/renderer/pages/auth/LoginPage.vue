<template>
  <section class="card-section">
    <h2>用户登录</h2>
    <p>登录会解锁 RootID，用于签名与授权。</p>

    <div class="row">
      <label>
        登录密码
        <input v-model="password" type="password" placeholder="输入注册密码" />
      </label>
    </div>

    <div class="row">
      <button @click="submit" :disabled="busy">解锁 RootID</button>
    </div>

    <p class="hint">{{ message }}</p>
  </section>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';

export default defineComponent({
  name: 'LoginPage',
  props: {
    busy: {
      type: Boolean,
      default: false
    }
  },
  emits: ['login'],
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
