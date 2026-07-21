<template>
  <el-card>
    <template #header>
      <div>
        <h2>恢复账号</h2>
        <p class="hint">通过助记词或备份二维码恢复 RootID。</p>
      </div>
    </template>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="助记词恢复" name="mnemonic">
        <el-form label-position="top">
          <el-form-item label="助记词（24 个汉字或英文单词，汉字可空格分隔或连续书写）">
            <el-input
              v-model="mnemonicInput"
              type="textarea"
              :rows="3"
              placeholder="输入注册时记录的 24 个助记词"
              :disabled="busy"
            />
          </el-form-item>
        </el-form>
        <template v-if="checkWords.length > 0">
          <div class="mnemonic-grid">
            <span
              v-for="(word, index) in checkWords"
              :key="index"
              class="mnemonic-word"
              :class="{ invalid: invalidIndexes.includes(index) }"
            >
              <em>{{ index + 1 }}</em>
              {{ word }}
            </span>
          </div>
          <p class="hint">
            已识别 {{ checkWords.length }} / 24 个词<template v-if="invalidIndexes.length > 0">，红色为词表外错字</template>
          </p>
        </template>
        <el-form label-position="top">
          <el-form-item label="新登录密码">
            <el-input v-model="newPassword" type="password" show-password placeholder="至少 8 位" :disabled="busy" />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="confirmPassword" type="password" show-password placeholder="重复输入新密码" :disabled="busy" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="busy" :disabled="!mnemonicReady" @click="submitMnemonic">恢复账号</el-button>
          </el-form-item>
        </el-form>
        <p class="hint">助记词是账号最高权限：恢复无需旧密码，恢复后原设备密码不再适用。</p>
      </el-tab-pane>

      <el-tab-pane label="二维码恢复" name="qr">
        <p class="hint">选择此前在"我的"页面保存的备份二维码图片。二维码是加密备份，需配合原登录密码恢复。</p>
        <div class="row">
          <el-button :disabled="busy" @click="triggerFileSelect">选择二维码图片</el-button>
          <span v-if="qrPayload" class="ok-text">已识别备份二维码</span>
        </div>
        <input ref="fileInput" type="file" accept="image/*" class="hidden-input" @change="onFileChange" />
        <el-form v-if="qrPayload" label-position="top" class="block-gap">
          <el-form-item label="原登录密码">
            <el-input v-model="qrPassword" type="password" show-password placeholder="输入备份时的登录密码" :disabled="busy" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="busy" :disabled="!qrPassword" @click="submitQr">恢复账号</el-button>
          </el-form-item>
        </el-form>
      </el-tab-pane>
    </el-tabs>

    <div class="entry-link">
      <el-button link type="info" @click="emit('back')">{{ backLabel }}</el-button>
    </div>

    <el-alert v-if="message" :title="message" type="error" :closable="false" show-icon class="block-gap" />
  </el-card>
</template>

<script lang="ts">
import { computed, defineComponent, ref, watch } from 'vue';
import jsQR from 'jsqr';
import { errorMessage } from '../../utils/ipc';

export default defineComponent({
  name: 'RecoverPage',
  props: {
    /** 返回按钮文案（由父级按返回目标传入，如"返回注册"/"返回用户列表"） */
    backLabel: {
      type: String,
      default: '返回注册'
    }
  },
  emits: ['recovered', 'back'],
  setup(_, { emit }) {
    const activeTab = ref<'mnemonic' | 'qr'>('mnemonic');
    const busy = ref(false);
    const message = ref('');

    // ---------------- 助记词恢复 ----------------
    const mnemonicInput = ref('');
    const checkWords = ref<string[]>([]);
    const invalidIndexes = ref<number[]>([]);
    const newPassword = ref('');
    const confirmPassword = ref('');

    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    watch(mnemonicInput, (value) => {
      if (checkTimer) {
        clearTimeout(checkTimer);
      }
      checkTimer = setTimeout(async () => {
        try {
          const result = await window.electronAPI.rootIdentity.checkMnemonic(value);
          checkWords.value = result.words;
          invalidIndexes.value = result.invalidIndexes;
        } catch {
          checkWords.value = [];
          invalidIndexes.value = [];
        }
      }, 300);
    });

    const mnemonicReady = computed(
      () =>
        checkWords.value.length === 24 &&
        invalidIndexes.value.length === 0 &&
        newPassword.value.length >= 8 &&
        newPassword.value === confirmPassword.value
    );

    const submitMnemonic = async () => {
      busy.value = true;
      message.value = '';
      try {
        const result = await window.electronAPI.rootIdentity.recoverMnemonic(mnemonicInput.value, newPassword.value);
        emit('recovered', result.rootId);
      } catch (error) {
        message.value = `恢复失败：${errorMessage(error)}`;
      } finally {
        busy.value = false;
      }
    };

    // ---------------- 二维码恢复 ----------------
    const fileInput = ref<HTMLInputElement | null>(null);
    const qrPayload = ref('');
    const qrPassword = ref('');

    const triggerFileSelect = () => {
      fileInput.value?.click();
    };

    const onFileChange = async (event: Event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        return;
      }
      message.value = '';
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('no-canvas');
        }
        context.drawImage(bitmap, 0, 0);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = jsQR(imageData.data, imageData.width, imageData.height);
        if (!decoded?.data) {
          message.value = '无法识别图片中的二维码，请确认图片清晰完整';
          qrPayload.value = '';
          return;
        }
        qrPayload.value = decoded.data;
      } catch {
        message.value = '图片读取失败，请换一张图片重试';
        qrPayload.value = '';
      }
    };

    const submitQr = async () => {
      busy.value = true;
      message.value = '';
      try {
        const result = await window.electronAPI.rootIdentity.recoverBackup(qrPayload.value, qrPassword.value);
        emit('recovered', result.rootId);
      } catch (error) {
        message.value = `恢复失败：${errorMessage(error)}`;
      } finally {
        busy.value = false;
      }
    };

    return {
      activeTab,
      busy,
      message,
      mnemonicInput,
      checkWords,
      invalidIndexes,
      newPassword,
      confirmPassword,
      mnemonicReady,
      submitMnemonic,
      fileInput,
      qrPayload,
      qrPassword,
      triggerFileSelect,
      onFileChange,
      submitQr,
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
  margin: 10px 0;
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

.mnemonic-word.invalid {
  border-color: #f56c6c;
  color: #f56c6c;
  background: #fef0f0;
}

.row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.ok-text {
  color: #67c23a;
}

.hidden-input {
  display: none;
}

.entry-link {
  margin-top: 8px;
}

.block-gap {
  margin-top: 12px;
}
</style>
