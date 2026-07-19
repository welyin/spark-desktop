import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

/**
 * 渲染进程构建配置（由 @electron-forge/plugin-vite 调用）
 * 入口为 src/renderer/index.html，产物输出到 .vite/renderer/main_window/；
 * dev server 固定 127.0.0.1:5199，与主进程 resolveDevServerUrl 的回退地址一致。
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true
  }
});
