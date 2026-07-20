# 星火 Spark 桌面端

## 项目简介

星火（Spark）是一款面向基层社区自治的分布式协作工具底座，基于 P2P 对等网络构建，无中心化服务器，数据由社区成员共同持有与管理。

项目以「群众自主掌握公共事务工具」为核心出发点，为业委会筹建、业主议事表决、邻里互助、公共账目公开等社区自治场景，提供抗关停、防篡改、保隐私的技术支撑，让基层自治的规则与数据真正回归全体成员。

星星之火，可以燎原。从一个小区起步，让每个社区都能拥有属于自己的自治基础设施。

## 核心特性

1. **分布式无中心架构**

   基于 libp2p 构建对等网络，无单点故障，不存在可被一键关停的中心服务；数据在多个节点间冗余备份，单个节点离线不影响整体网络运行，保障自治活动持续运转。
2. **数据主权完全归用户**

   所有原始业务数据存储于用户本地设备，链上仅留存哈希存证用于校验；不存在第三方平台掌控业主信息，从根源避免数据泄露、被商业利用或被针对性拿捏的风险。
3. **插件化可扩展骨架**

   核心程序仅提供网络、身份、存证等基础能力，所有业务功能均通过插件实现。社区可根据自身需求选用、开发插件，不受固定功能限制，真正实现「自治工具由使用者定义」。
4. **原生适配社区自治规则**

   内置「一户一票」身份权限体系，支持可验证的电子签名与投票存证，结果可追溯、可核验，贴合业委会选举、公共事项表决的合规要求，替代传统纸质签字的低效模式。
5. **跨端协同的分层设计**

   桌面端承担全节点职能（数据存储、共识校验、网络中继），面向社区骨干与筹备组；搭配移动端轻客户端满足普通业主日常使用，兼顾网络健壮性与大众易用性。

## 技术架构

项目采用分层解耦设计，整体自下而上分为四层：

1. **网络层**：基于 js-libp2p 实现，支持 TCP/QUIC/WebSocket 多传输协议，内置 NAT 穿透与局域网节点自动发现，每个社区为独立的许可式子网。
2. **共识存证层**：采用链式操作日志 + 改进型 PBFT 共识机制，仅在许可节点间达成共识，秒级确认，保障数据不可篡改、结果最终一致。
3. **基础骨架层**：提供身份密钥管理、权限控制、插件沙箱运行时、本地数据存储等核心能力，是所有插件的运行基础。
4. **应用插件层**：承载投票、签名、账目、通知等具体业务功能，可按需安装卸载。

### 节点分层

* **火种节点(核心共识节点)**：24 小时在线，存储全量数据，参与共识校验，是网络的核心支柱，由社区热心骨干使用闲置设备运行。
* **普通中继节点**：用户日常使用的桌面端，开机时加入网络，承担数据缓存与通讯中继，关机不影响整体网络。
* **轻量客户端**：移动端仅同步必要业务数据，不参与存储与共识，面向普通业主日常交互。

### 核心技术栈

* 桌面框架：Electron
* 前端技术：Vue 3 + TypeScript + Vite
* P2P 网络：js-libp2p
* 本地存储：SQLite（结构化业务数据） + LevelDB（链式存证日志）
* 加密体系：Ed25519 非对称加密 + 群组端到端加密

## 快速开始

### 环境要求

* Node.js >= 18.0.0
* 包管理器：npm /pnpm
* 操作系统：Windows 10+ /macOS 11+ / Linux 主流发行版

### 本地开发

bash

运行

```
# 克隆仓库
git clone https://gitee.com/your-org/spark-desktop.git
cd spark-desktop

# 安装依赖
npm install

# 启动开发环境（渲染进程热更新 + 主进程自动重启）
npm run dev
```

### 生产构建

bash

运行

```
# 构建当前平台安装包
npm run build

# 跨平台全量构建（Windows/Mac/Linux）
npm run build:all
```

构建产物将输出至 `release` 目录。

## 核心功能与内置插件

### 基础骨架能力（核心内置，不可卸载）

* **节点管理面板**：查看节点状态、连接节点列表、网络延迟、数据同步进度
* **身份系统**：本地生成公私钥、备份助记词、管理社区身份凭证
* **存证核验工具**：输入记录哈希即可跨节点校验数据完整性
* **插件管理器**：插件安装 / 卸载 / 权限配置、插件市场入口
* **数据备份恢复**：一键导出 / 导入本地数据，保障数据安全

### 首批内置插件

1. **业主身份核验**：支持房产证明哈希核验、老业主引荐制加入，绑定户号与投票权重
2. **议事投票系统**：支持议题发起、一户一票匿名投票、结果自动统计存证，适配业委会选举、公共决策等多种场景
3. **签名征集工具**：线上实名签名征集，自动统计户数与面积占比，支持导出合规格式文件
4. **公共账目公开**：收支记录逐条上链存证，全体业主可查可追溯，杜绝财务不透明问题
5. **社区通知公告**：全网广播送达，历史记录永久留存，支持已读回执

## 插件开发

星火采用「核心骨架 + 插件应用」的开放架构，所有业务功能均可通过插件扩展。

* 插件基于 Node.js + Vue 3 开发，运行于独立沙箱环境，严格限制权限范围
* 骨架向插件开放标准化 API：数据读写、社区广播、身份校验、UI 界面注入
* 详细开发规范请参考 [插件开发文档](https://github.com/welyin/spark-desktop/wiki/dev/plugin-development)

### 组织基础插件约束（新增）

* 新建组织时，必须选择一个基础插件（当前内置 `plugin:weibo-core`）。
* 基础插件会写入组织元数据 `basePluginDomain`，组织内业务插件可据此决定是否启用。
* 该约束由主进程强制校验，前端仅负责交互选择。

### 微博基础插件（plugin:weibo-core）

已内置一个“微博式”基础插件用于验证插件独立性与 P2P 同步：

* 组织首次使用插件时，插件自动记录主管理员（组织创建者默认主管理员）。
* 仅主管理员可发布 260 字以内短文。
* 组织内所有成员（包含管理员）均可评论、回复，评论/回复同样限制 260 字。
* 所有插件业务数据落在插件域独立集合，通过插件 SDK 的文档 API 读写，并走既有 P2P 广播同步链路。

### 插件独立打包/更新（骨架）

提供独立打包脚本：

```bash
npm run plugin:package:weibo
```

输出目录：`dist/plugins/weibo-core/`

* `update-manifest.json`：插件更新清单（版本、文件、sha256、size）
* 插件源码产物副本（用于后续接入插件安装器与远程分发）

该机制用于后续演进插件“独立安装、独立更新”，与主程序更新链路解耦。

### GitHub Actions 并行发布（主程序 + 插件）

当前仓库已支持两条并行发布工作流：

* 主程序更新清单：`.github/workflows/release-updater-manifest.yml`
* 插件更新清单：`.github/workflows/release-plugin-weibo.yml`

插件工作流会在 Release 发布时自动执行：

1. 构建插件包 `spark-plugin-weibo-core-<version>.spkg`
2. 生成 `spark-plugin-weibo-core-manifest.json`
3. 生成 detached 签名 `spark-plugin-weibo-core-manifest.sig`
4. 上传包、manifest、sig、pub key、checksums 到同一个 GitHub Release

插件工作流所需仓库 Secret：

* `SPARK_PLUGIN_SIGNING_PRIVATE_KEY`：插件 manifest 签名私钥（Ed25519）

客户端校验公钥配置：

* `SPARK_PLUGIN_UPDATE_PUBLIC_KEY_PEM`：插件更新校验公钥（支持 `@@` 多 key）

## 插件市场与独立更新链路（新增）

### 插件市场（Apps 页面）

Apps 页面已升级为“插件市场”视图，支持：

* 一键安装
* 检查更新（单插件/全量）
* 升级
* 启用/停用
* 基础插件筛选（用于组织基座插件选择）

### 安装器与更新签名校验

主进程新增插件市场服务（PluginMarketService），对齐主程序 updater 的信任模型：

* 拉取插件 `update-manifest.json` 与 `update-manifest.sig`
* 使用 Ed25519 公钥校验 detached signature
* 下载插件包并校验 SHA-256 与 size
* 持久化插件安装状态（版本、启停状态、包路径）

默认使用 `SPARK_PLUGIN_UPDATE_PUBLIC_KEY_PEM`（支持多 key，以 `@@` 分隔），未设置时回退内置公钥。

### 本地打包签名命令

```bash
npm run plugin:package:weibo
```

会产出：

* `dist/plugins/weibo-core/spark-plugin-weibo-core-0.1.0.spkg`
* `dist/plugins/weibo-core/update-manifest.json`
* `dist/plugins/weibo-core/update-manifest.sig`

签名私钥来源：

* 环境变量 `SPARK_PLUGIN_SIGNING_PRIVATE_KEY`
* 或本地文件 `.secrets/spark-update-signing-private-key.pem`

## 微博插件自动化测试（新增）

已增加自动化测试覆盖：

* 权限：仅主管理员可发帖
* 文本约束：260 字上限
* 评论回复结构：根评论 + 回复结构构建
* 同步回归：按 `orgId` 维度查询，确保跨端同步作用域稳定
## 主程序热更新（GitHub 发布中心）

当前已接入第一阶段更新链路：

1. Manifest 签名校验（Ed25519 公钥内置/环境注入）
2. 更新包 SHA-256 完整性校验
3. 反回滚（记录本地最高已接受版本）
4. 平台签名主体校验（macOS 通过 `spctl`）

### 运行时环境变量

* `SPARK_UPDATE_APP_ID`：应用标识，默认 `spark-desktop`
* `SPARK_UPDATE_CHANNEL`：更新通道，默认 `stable`
* `SPARK_UPDATE_MANIFEST_URL`：manifest 地址
* `SPARK_UPDATE_SIGNATURE_URL`：manifest 签名地址（base64）
* `SPARK_UPDATE_PUBLIC_KEY_PEM`：受信任公钥（必填）

`SPARK_UPDATE_PUBLIC_KEY_PEM` 支持多公钥轮换，多个 PEM 使用 `@@` 拼接。

### Manifest 最小示例

```json
{
   "manifestVersion": 1,
   "appId": "spark-desktop",
   "channel": "stable",
   "version": "0.2.0",
   "releaseTime": "2026-07-10T00:00:00.000Z",
   "critical": false,
   "revokedVersions": ["0.1.0"],
   "assets": [
      {
         "kind": "full",
         "platform": "darwin",
         "arch": "arm64",
         "fileName": "spark-desktop-darwin-arm64-v0.2.0.dmg",
         "url": "https://github.com/welyin/spark-desktop/releases/download/v0.2.0/spark-desktop-darwin-arm64-v0.2.0.dmg",
         "sha256": "<sha256-hex>",
         "size": 123456789,
         "codeSignSubject": "Developer ID Application: <Team Name> (<TeamID>)"
      }
   ]
}
```

### IPC 接口（系统域）

* `update-status`：获取更新器状态快照
* `update-check`：主动检查更新
* `update-stage-latest`：下载并校验最新全量包到本地 staging
* `update-apply-restart`：写入待安装状态并重启主程序
* `update-observe-peer-version`：接收对端版本触发检查（不直接信任对端包）

### GitHub Actions 联动

仓库已提供工作流 [release-updater-manifest.yml](.github/workflows/release-updater-manifest.yml)：

1. 在 Release 发布后自动拉取该版本资产。
2. 计算每个安装包 SHA-256 与大小。
3. 生成 `spark-manifest.json` 与 `spark-checksums.txt`。
4. 使用发布私钥签名生成 `spark-manifest.sig`。
5. 回传上传到同一个 GitHub Release。

必须在 GitHub 仓库设置的 Secret：

* `SPARK_UPDATE_SIGNING_PRIVATE_KEY`：Ed25519 私钥 PEM（仅用于 CI 签名）

本地开发可使用仓库根目录私钥文件（已加入忽略，不会提交）：

* `.secrets/spark-update-signing-private-key.pem`
* `.secrets/spark-update-signing-public-key.pem`

必须在客户端运行环境提供的变量（或通过代码内置默认值覆盖）：

* `SPARK_UPDATE_PUBLIC_KEY_PEM`：与上面私钥对应的公钥 PEM（可多 key，用 `@@` 分隔）；未设置时默认使用代码内置公钥
* `SPARK_UPDATE_MANIFEST_URL`
* `SPARK_UPDATE_SIGNATURE_URL`

说明：

* GitHub Actions 可以直接写入 Release 资产，但无法替你在仓库后台自动创建 Secret。
* `SPARK_UPDATE_SIGNING_PRIVATE_KEY` 只能放在 GitHub Secret 或 KMS，严禁提交到仓库。

## 隐私与安全

1. **本地优先原则**：所有原始业务数据仅存储于用户本地设备，敏感个人信息不全网广播、不上链。
2. **端到端加密**：同一社区内的所有业务数据采用群组密钥加密，外部节点与非社区成员无法解密。
3. **身份隐私保护**：网络中仅使用公钥作为身份标识，真实身份信息由用户自主控制披露，避免成员信息被批量获取。
4. **许可制子网**：每个社区为独立私有网络，节点加入必须通过身份核验，从网络层隔绝恶意节点入侵。

## 参与贡献

欢迎以任何形式参与项目建设：

* 提交 Issue 反馈 Bug、提出功能建议
* 提交 PR 修复问题、优化代码、新增能力
* 开发适配不同场景的功能插件
* 参与文档翻译、使用教程编写

详细规范请阅读 [贡献指南](https://github.com/welyin/spark-desktop/blob/main/CONTRIBUTING.md)。

## 开源协议

本项目基于 **MIT** 协议开源，详见 [LICENSE](./LICENSE) 文件。

## 免责声明

1. 本项目仅用于合法的基层社区自治、业主公共事务协商等合规场景，严禁用于任何违反法律法规的活动。
2. 使用本项目所产生的所有行为与后果，由使用者自行承担，项目开发团队不承担相关法律责任。
3. 请使用者严格遵守所在地区的法律法规与物业管理相关规定，依法依规开展自治活动。

---

星星之火，可以燎原。
