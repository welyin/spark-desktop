<template>
  <section class="card-page">
    <h1>应用</h1>
    <p>打开插件页面会在左侧新增一个 tab，并显示插件图标。</p>

    <section class="card nested">
      <h2>插件 Tab 管理</h2>
      <div class="row">
        <label>
          插件域
          <input v-model="domain" type="text" placeholder="plugin:demo" />
        </label>
        <label>
          视图 ID
          <input v-model="view" type="text" placeholder="default" />
        </label>
      </div>
      <div class="row">
        <label>
          标签标题
          <input v-model="title" type="text" placeholder="Demo 插件" />
        </label>
        <label>
          图标文字
          <input v-model="icon" type="text" maxlength="2" placeholder="D" />
        </label>
      </div>
      <div class="row">
        <button @click="openPluginTab">打开插件 Tab</button>
      </div>
      <div class="status">
        <strong>状态：</strong>{{ message }}
      </div>
    </section>
  </section>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';

export type OpenPluginTabPayload = {
  pluginDomain: string;
  pluginView: string;
  title: string;
  icon: string;
};

export default defineComponent({
  name: 'AppsPage',
  emits: ['open-plugin-tab'],
  setup(_, { emit }) {
    const domain = ref('plugin:demo');
    const view = ref('default');
    const title = ref('Demo 插件');
    const icon = ref('D');
    const message = ref('等待打开插件 Tab');

    const openPluginTab = () => {
      const pluginDomain = domain.value.trim();
      const pluginView = view.value.trim() || 'default';
      const tabTitle = title.value.trim() || `${pluginDomain}/${pluginView}`;
      const tabIcon = icon.value.trim() || tabTitle.slice(0, 1).toUpperCase();

      emit('open-plugin-tab', {
        pluginDomain,
        pluginView,
        title: tabTitle,
        icon: tabIcon
      } as OpenPluginTabPayload);

      message.value = `已请求打开插件 Tab：${tabTitle}`;
    };

    return {
      domain,
      view,
      title,
      icon,
      message,
      openPluginTab
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

input {
  margin-left: 8px;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
}

button {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  cursor: pointer;
}

.status {
  margin-top: 8px;
  color: #333;
}
</style>
