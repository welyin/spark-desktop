<template>
  <section class="card-page">
    <h1>测试</h1>
    <p>这里是测试页面。</p>

    <section class="card nested">
      <h2>LevelDB 测试面板</h2>
      <div class="row">
        <button @click="$emit('open-db')" :disabled="dbStatus.open">打开数据库</button>
        <button @click="$emit('close-db')" :disabled="!dbStatus.open">关闭数据库</button>
      </div>
      <div class="row">
        <button @click="$emit('put-value')" :disabled="!dbStatus.open">Put 键值</button>
        <button @click="$emit('get-value')" :disabled="!dbStatus.open">Get 键值</button>
        <button @click="$emit('del-value')" :disabled="!dbStatus.open">Del 键值</button>
        <button @click="$emit('batch-ops')" :disabled="!dbStatus.open">Batch 操作</button>
      </div>
      <div class="status">
        <strong>数据库路径：</strong>{{ dbPath }}
      </div>
      <div class="status">
        <strong>打开状态：</strong>{{ dbStatus.open ? '已打开' : '已关闭' }}
      </div>
      <div class="status">
        <strong>结果：</strong>{{ resultMessage }}
      </div>
    </section>
  </section>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue';

export default defineComponent({
  name: 'TestPage',
  props: {
    dbStatus: {
      type: Object as PropType<{ open: boolean }>,
      required: true
    },
    dbPath: {
      type: String,
      required: true
    },
    resultMessage: {
      type: String,
      required: true
    }
  },
  emits: ['open-db', 'close-db', 'put-value', 'get-value', 'del-value', 'batch-ops']
});
</script>

<style scoped>
.card-page {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}

.card {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}

.nested {
  margin-top: 16px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

button {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.status {
  margin-top: 8px;
  color: #333;
}
</style>
