import { defineConfig } from 'vite';

/**
 * preload 构建配置（由 @electron-forge/plugin-vite 调用）
 * 输出 .vite/build/preload.js（CJS），主进程经 path.join(__dirname, 'preload.js') 引用。
 * preload.ts 仅依赖 electron，其余均为编译期擦除的类型导入，无需额外配置。
 */
export default defineConfig({});
