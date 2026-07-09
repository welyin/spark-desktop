<template>
  <section class="affairs-page">
    <el-card shadow="never">
      <template #header>
        <h1>事务</h1>
      </template>
      <el-empty description="这里是事务页面。" />
    </el-card>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'AffairsPage'
});
</script>

<style scoped>
.affairs-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

h1 {
  margin: 0;
}
</style>
