/**
 * electron 模块的 node 运行桩：仅覆盖 p2p-lab 脚本依赖图触及的 API。
 * root-id.ts 只在 RootIdentityManager 存储路径处使用 app.getPath，
 * 实验场景用不到该单例，提供惰性路径即可。
 */
import { tmpdir } from 'os';
import path from 'path';

export const app = {
  getPath: () => path.join(tmpdir(), 'spark-p2p-lab-electron-stub'),
  getVersion: () => 'p2p-lab'
};

export const powerMonitor = {
  on: () => {}
};

export default {};
