/**
 * Electron Forge 配置（v7）
 *
 * ignore 说明：plugin-vite 默认只保留 .vite 构建产物，但本应用运行时需要
 * node_modules —— level 为原生模块外部引用、libp2p 经运行时动态 import 加载。
 * 因此显式保留 .vite 与 node_modules（electron-packager 默认 prune 掉 devDependencies）。
 */
module.exports = {
  packagerConfig: {
    ignore: (file) => {
      if (!file) {
        return false;
      }
      if (file.startsWith('/.vite')) {
        return false;
      }
      if (file === '/package.json' || file === '/package-lock.json') {
        return false;
      }
      if (file.startsWith('/node_modules')) {
        return false;
      }
      return true;
    }
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32']
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main/index.ts',
            config: 'vite.main.config.ts'
          },
          {
            entry: 'src/main/preload.ts',
            config: 'vite.preload.config.ts',
            target: 'preload'
          }
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.ts'
          }
        ]
      }
    }
  ]
};
