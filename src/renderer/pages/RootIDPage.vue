<template>
  <section class="card-page">
    <h1>RootID 页面</h1>
    <p>RootID 是用户唯一的本地底层主权凭证，所有域身份、签名、授权都由它派生签发。</p>

    <section class="info-grid">
      <article class="info-card">
        <h2>域身份派生</h2>
        <p>从 RootID 按 SLIP-0010 Ed25519 硬化路径派生出域身份，用于插件、组织、应用等不同域。</p>
        <p class="muted">功能：为不同域生成独立公钥与域标识，避免共享根私钥。</p>
      </article>
      <article class="info-card">
        <h2>RootID 签名</h2>
        <p>对修改数据、跨域授权和治理操作进行 Ed25519 签名，主进程可校验签名真实性。</p>
        <p class="muted">功能：证明操作由当前登录的 RootID 所属用户发起。</p>
      </article>
      <article class="info-card">
        <h2>助记词</h2>
        <p>24 词助记词是 RootID 的恢复凭证，当前仅在注册成功时展示一次，不能通过页面重新读取。</p>
        <p class="muted">功能：设备丢失或迁移时恢复 RootID（需用户自行妥善离线保存）。</p>
      </article>
    </section>

    <section class="card-section">
      <h2>RootID 相关信息</h2>
      <div class="status-grid">
        <div class="status-item"><strong>是否已注册：</strong>{{ rootStatus.initialized ? '是' : '否' }}</div>
        <div class="status-item"><strong>是否已登录：</strong>{{ rootStatus.unlocked ? '是' : '否' }}</div>
        <div class="status-item"><strong>RootID：</strong>{{ rootStatus.rootId || '未创建' }}</div>
      </div>

      <div class="row">
        <button @click="refreshStatus">刷新状态</button>
        <button class="warn" @click="handleLogout">退出登录</button>
      </div>

      <div class="split">
        <section>
          <h3>域身份派生</h3>
          <div class="row">
            <label>
              域名
              <input v-model="domainInput" type="text" placeholder="plugin:demo" />
            </label>
            <button @click="deriveDomainIdentity">派生域身份</button>
          </div>
          <div v-if="derivedDomain" class="mono-box">
            <div><strong>domain:</strong> {{ derivedDomain.domain }}</div>
            <div><strong>domainId:</strong> {{ derivedDomain.domainId }}</div>
            <div><strong>publicKey:</strong> {{ derivedDomain.publicKey }}</div>
            <div><strong>path:</strong> {{ derivedDomain.derivationPath }}</div>
          </div>
        </section>

        <section>
          <h3>RootID 签名</h3>
          <div class="row">
            <label class="flex-grow">
              待签名文本
              <input v-model="payloadInput" type="text" placeholder="hello-root-id" />
            </label>
            <button @click="signPayload">签名</button>
          </div>
          <div v-if="signatureResult" class="mono-box">
            <div><strong>rootId:</strong> {{ signatureResult.rootId }}</div>
            <div><strong>payloadHash:</strong> {{ signatureResult.payloadHash }}</div>
            <div><strong>signature:</strong> {{ signatureResult.signature }}</div>
          </div>
        </section>
      </div>

    </section>

    <p class="message">{{ message }}</p>
  </section>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue';

type RootStatus = {
  initialized: boolean;
  unlocked: boolean;
  rootId: string | null;
};

type DerivedDomain = {
  domain: string;
  domainId: string;
  publicKey: string;
  derivationPath: string;
};

type SignatureResult = {
  rootId: string;
  signature: string;
  payloadHash: string;
};

export default defineComponent({
  name: 'RootIDPage',
  emits: ['logout'],
  setup(_, { emit }) {
    const rootStatus = ref<RootStatus>({ initialized: false, unlocked: false, rootId: null });
    const message = ref('');
    const domainInput = ref('plugin:demo');
    const derivedDomain = ref<DerivedDomain | null>(null);
    const payloadInput = ref('hello-root-id');
    const signatureResult = ref<SignatureResult | null>(null);

    const refreshStatus = async () => {
      rootStatus.value = await window.electronAPI.rootIdentity.status();
    };

    const handleLogout = async () => {
      try {
        await window.electronAPI.rootIdentity.lock();
        message.value = '已退出登录';
        derivedDomain.value = null;
        signatureResult.value = null;
        await refreshStatus();
        emit('logout');
      } catch (error) {
        message.value = `退出失败：${error}`;
      }
    };

    const deriveDomainIdentity = async () => {
      try {
        derivedDomain.value = await window.electronAPI.rootIdentity.deriveDomain(domainInput.value.trim());
        message.value = `已派生域身份：${derivedDomain.value.domain}`;
      } catch (error) {
        message.value = `派生失败：${error}`;
      }
    };

    const signPayload = async () => {
      try {
        signatureResult.value = await window.electronAPI.rootIdentity.sign(payloadInput.value);
        message.value = '签名成功';
      } catch (error) {
        message.value = `签名失败：${error}`;
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
      message,
      domainInput,
      derivedDomain,
      payloadInput,
      signatureResult,
      refreshStatus,
      handleLogout,
      deriveDomainIdentity,
      signPayload
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

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin: 16px 0;
}

.info-card {
  padding: 14px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e5e7eb;
}

.muted {
  color: #6b7280;
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

.split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.flex-grow {
  flex: 1;
}

input {
  margin-left: 8px;
  padding: 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  min-width: 240px;
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

.mono-box {
  margin-top: 10px;
  padding: 10px;
  border-radius: 8px;
  background: #111827;
  color: #e5e7eb;
  font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
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
