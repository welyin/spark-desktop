<template>
  <section class="card-page">
    <h1>应用</h1>
    <p>打开插件页面会在左侧新增一个 tab，并显示插件图标。</p>

    <el-card class="nested">
      <template #header>
        <h2>插件 Tab 管理</h2>
      </template>

      <el-form label-position="top">
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12">
            <el-form-item label="插件域">
              <el-input v-model="domain" placeholder="plugin:demo" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="视图 ID">
              <el-input v-model="view" placeholder="default" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :xs="24" :sm="12">
            <el-form-item label="标签标题">
              <el-input v-model="title" placeholder="Demo 插件" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="图标文字">
              <el-input v-model="icon" maxlength="2" placeholder="D" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item>
          <el-button type="primary" @click="openPluginTab">打开插件 Tab</el-button>
        </el-form-item>
      </el-form>

      <el-alert :title="`状态：${message}`" type="info" :closable="false" show-icon />
    </el-card>
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
}

.nested {
  margin-top: 16px;
}
</style>
