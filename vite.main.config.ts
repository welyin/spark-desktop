import { defineConfig } from 'vite';

/**
 * 主进程构建配置（由 @electron-forge/plugin-vite 调用）
 *
 * - level 为原生模块（classic-level 预编译二进制），不能打进 bundle，保持外部引用，
 *   由打包后的 node_modules 提供；
 * - libp2p 系列经 p2p-node.ts 的 runtimeImport（new Function 动态 import）在运行时
 *   从 node_modules 加载，不参与打包；
 * - 其余依赖（bip39、tweetnacl 等纯 JS）直接打进 CJS bundle。
 * - lib.fileName 显式固定为 main.js，与 package.json 的 main 字段对应。
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/index.ts',
      fileName: () => 'main.js',
      formats: ['cjs']
    },
    rollupOptions: {
      external: ['level', 'classic-level', 'node-gyp-build']
    }
  }
});
