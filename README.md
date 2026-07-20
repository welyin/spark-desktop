# 星火 Spark 桌面端

星火（Spark）是一款面向基层社区自治的分布式协作工具底座，基于 P2P 对等网络构建，无中心化服务器，数据由社区成员共同持有与管理。

项目以「群众自主掌握公共事务工具」为核心出发点，为业委会筹建、业主议事表决、邻里互助、公共账目公开等场景，提供抗关停、防篡改、保隐私的技术支撑，让基层自治的规则与数据真正回归全体成员。

星星之火，可以燎原。从一个小区起步，让每个社区都能拥有属于自己的自治基础设施。

## 核心特性

- **分布式无中心架构**：基于 libp2p 构建对等网络，无单点故障，数据多节点冗余备份。
- **数据主权完全归用户**：原始业务数据仅存于用户本地设备，链上仅留存哈希存证。
- **插件化可扩展骨架**：核心程序提供网络、身份、存证等基础能力，所有业务功能通过插件实现。
- **原生适配社区自治规则**：支持可验证的电子签名与投票存证，贴合业委会选举、公共决策的合规要求。
- **跨端协同的分层设计**：桌面端承担全节点职能，移动端提供轻客户端体验。

## 技术栈

- 桌面框架：Electron
- 前端技术：Vue 3 + TypeScript + Vite
- P2P 网络：js-libp2p
- 本地存储：LevelDB（链式存证日志）+ 插件文档集合
- 加密体系：Ed25519 非对称加密 + 群组端到端加密

> 更详细的架构、设计与实现说明，请查阅 [Spark Wiki](https://github.com/welyin/spark-desktop/wiki)。

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- 包管理器：npm / pnpm
- 操作系统：Windows 10+ / macOS 11+ / Linux 主流发行版

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/welyin/spark-desktop.git
cd spark-desktop

# 安装依赖
npm install

# 启动开发环境（渲染进程热更新 + 主进程自动重启）
npm run dev
```

### 生产构建

```bash
# 构建当前平台安装包
npm run build

# 跨平台全量构建（Windows/Mac/Linux）
npm run build:all
```

构建产物将输出至 `release` 目录。

## 文档

详细文档已迁移至 [GitHub Wiki](https://github.com/welyin/spark-desktop/wiki)，主要入口：

- [项目简介](https://github.com/welyin/spark-desktop/wiki/project_intro)
- [产品设计文档](https://github.com/welyin/spark-desktop/wiki/design/design_overview)
- [插件开发指南](https://github.com/welyin/spark-desktop/wiki/dev/plugin_development)
- [开发计划](https://github.com/welyin/spark-desktop/wiki/dev/development_plan)
- [术语表](https://github.com/welyin/spark-desktop/wiki/design/glossary)

## 插件开发

星火采用「核心骨架 + 插件应用」的开放架构，所有业务功能均可通过插件扩展。插件基于 Node.js + Vue 3 开发，运行于独立沙箱环境，通过标准化 SDK 调用底层能力。

详细开发规范请参考 [插件开发文档](https://github.com/welyin/spark-desktop/wiki/dev/plugin_development)。

## 参与贡献

欢迎以任何形式参与项目建设：

- 提交 Issue 反馈 Bug、提出功能建议
- 提交 PR 修复问题、优化代码、新增能力
- 开发适配不同场景的功能插件
- 参与文档翻译、使用教程编写

详细规范请阅读 [贡献指南](https://github.com/welyin/spark-desktop/blob/main/CONTRIBUTING.md)。

## 开源协议

本项目基于 **MIT** 协议开源，详见 [LICENSE](./LICENSE) 文件。

## 免责声明

1. 本项目仅用于合法的基层社区自治、业主公共事务协商等合规场景，严禁用于任何违反法律法规的活动。
2. 使用本项目所产生的所有行为与后果，由使用者自行承担，项目开发团队不承担相关法律责任。
3. 请使用者严格遵守所在地区的法律法规与物业管理相关规定，依法依规开展自治活动。

---

星星之火，可以燎原。
