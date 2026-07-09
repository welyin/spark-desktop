<template>
  <section class="card-page">
    <h1>事务</h1>
    <p>这里是事务页面。</p>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'AffairsPage'
});
</script>

<style scoped>
.card-page {
  padding: 16px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
}
</style>
