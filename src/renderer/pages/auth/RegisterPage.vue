<template>
  <el-card>
    <template #header>
      <div>
        <h2>用户注册</h2>
        <p class="hint">首次注册将创建 RootID（仅本地存储）。</p>
      </div>
    </template>

    <template v-if="step === 'password'">
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
      <div class="entry-link">
        <el-button link type="primary" @click="emit('recover')">已有助记词或备份二维码？恢复账号</el-button>
      </div>
    </template>

    <template v-else>
      <el-alert
        title="请离线抄写并妥善保存这 24 个汉字（顺序重要）。它是账号的最终兜底：不要截图、拍照或通过网络发送。"
        type="warning"
        :closable="false"
        show-icon
      />
      <div class="mnemonic-grid">
        <span v-for="(word, index) in mnemonicWords" :key="index" class="mnemonic-word">
          <em>{{ index + 1 }}</em>
          {{ word }}
        </span>
      </div>
      <div class="row">
        <el-button type="primary" @click="copyMnemonic">复制助记词</el-button>
        <el-button @click="finish" :disabled="!copied">进入应用</el-button>
      </div>
      <el-alert
        v-if="copied"
        title="已复制。请粘贴到安全的离线位置（如密码管理器），或按顺序抄写纸质保存。"
        type="success"
        :closable="false"
        show-icon
        class="block-gap"
      />
      <div class="entry-link">
        <el-button link type="info" @click="finish">稍后备份，先进入应用</el-button>
      </div>
    </template>

    <el-alert v-if="message" :title="message" type="error" :closable="false" show-icon class="block-gap" />
  </el-card>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { markIdentityBackupDone } from '../../utils/backup-state';
import { errorMessage } from '../../utils/ipc';

export default defineComponent({
  name: 'RegisterPage',
  emits: ['registered', 'recover'],
  setup(_, { emit }) {
    const step = ref<'password' | 'mnemonic'>('password');
    const password = ref('');
    const confirmPassword = ref('');
    const busy = ref(false);
    const message = ref('');
    const mnemonic = ref('');
    const rootId = ref('');
    const copied = ref(false);

    const mnemonicWords = computed(() => (mnemonic.value ? mnemonic.value.split(' ') : []));

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
        const result = await window.electronAPI.rootIdentity.initialize(password.value);
        mnemonic.value = result.mnemonic;
        rootId.value = result.rootId;
        step.value = 'mnemonic';
      } catch (error) {
        message.value = `注册失败：${errorMessage(error)}`;
      } finally {
        busy.value = false;
      }
    };

    const copyMnemonic = async () => {
      try {
        await navigator.clipboard.writeText(mnemonic.value);
        copied.value = true;
        markIdentityBackupDone(rootId.value);
        ElMessage.success('已复制助记词');
      } catch {
        ElMessage.warning('复制失败，请手动抄写助记词');
      }
    };

    const finish = () => {
      emit('registered', rootId.value);
    };

    return {
      step,
      password,
      confirmPassword,
      busy,
      message,
      mnemonicWords,
      copied,
      submit,
      copyMnemonic,
      finish,
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

.mnemonic-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  margin: 14px 0;
}

.mnemonic-word {
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 6px 0;
  text-align: center;
  font-size: 16px;
}

.mnemonic-word em {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: #94a3b8;
}

.row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.entry-link {
  margin-top: 8px;
}

.block-gap {
  margin-top: 12px;
}
</style>
