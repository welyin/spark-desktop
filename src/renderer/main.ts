import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { initializePlugins } from './plugin-loader';
import RootGate from './RootGate.vue';

initializePlugins();

createApp(RootGate).use(ElementPlus).mount('#app');
