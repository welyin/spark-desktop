<template>
  <div class="plugin-view">
    <h2>Demo 插件独立视图</h2>
    <p><strong>域：</strong>{{ domain }}</p>
    <div class="row">
      <button @click="writeDoc" :disabled="!ready">写入文档</button>
      <button @click="refresh" :disabled="!ready">刷新文档</button>
      <button @click="verify" :disabled="!ready">验证存证</button>
    </div>
    <p>{{ message }}</p>
    <ul>
      <li v-for="doc in docs" :key="doc.id">{{ doc.id }} - {{ doc.title }} - {{ doc.value }}</li>
      <li v-if="docs.length === 0">暂无文档</li>
    </ul>
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref } from 'vue';
import { listDemoDocs, setupDemoPlugin, verifyEvidence, writeDemoDoc } from './demo-plugin';

type DemoDocument = {
  id: string;
  title: string;
  value: string;
};

export default defineComponent({
  name: 'DemoDefaultView',
  setup() {
    const domain = ref('plugin:demo');
    const docs = ref<DemoDocument[]>([]);
    const message = ref('加载中...');
    const ready = ref(false);

    const refresh = async () => {
      if (!ready.value) {
        return;
      }
      docs.value = await listDemoDocs();
    };

    const writeDoc = async () => {
      if (!ready.value) {
        return;
      }
      try {
        const doc: DemoDocument = {
          id: `doc-${Date.now()}`,
          title: 'Demo Plugin View',
          value: `value-${Date.now()}`
        };
        await writeDemoDoc(doc);
        await refresh();
        message.value = `已写入 ${doc.id}`;
      } catch (error) {
        message.value = `写入失败：${error}`;
      }
    };

    const verify = async () => {
      if (!ready.value) {
        return;
      }
      try {
        const result = await verifyEvidence();
        message.value = result.valid ? `存证校验通过，高度 ${result.height}` : `存证校验失败，高度 ${result.height}`;
      } catch (error) {
        message.value = `验证失败：${error}`;
      }
    };

    onMounted(async () => {
      try {
        domain.value = await setupDemoPlugin();
        ready.value = true;
        await refresh();
        message.value = '插件独立视图已加载';
      } catch (error) {
        message.value = `初始化失败：${error}`;
      }
    });

    return {
      domain,
      docs,
      message,
      ready,
      writeDoc,
      verify,
      refresh
    };
  }
});
</script>

<style scoped>
.plugin-view {
  background: #fff;
}

.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 12px 0;
}

button {
  padding: 8px 14px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}
</style>