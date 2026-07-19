# Spark 插件开发指南

本文档用于说明 Spark 桌面端插件开发的基础模型、权限模型、SDK 接口，以及组织内插件数据同步策略。

## 1. 目标与原则

- 插件按域隔离运行，域名格式为 plugin:xxx。
- 插件数据与系统数据隔离，插件只能访问自身域的数据。
- 默认策略：同一组织下的插件数据自动同步。
- 仅在显式声明时，某条数据不参与组织同步。

## 2. 插件运行模型

- 主进程创建插件窗口并绑定可信域。
- 插件侧通过 SDK 与主进程 IPC 交互。
- 插件数据通过插件文档接口读写，底层落到插件域集合。

## 3. 权限模型

插件能力按敏感度分级，由主进程在 IPC 边界强制校验，越权调用直接抛错。

### 3.1 权限分级

- **基础权限**：默认授予所有插件，无需声明。
- **高级权限**：插件必须在 manifest 的 `permissions` 字段中声明，安装时由用户/管理员确认授权，授权结果持久化在插件安装状态中。

| 权限 | 级别 | 对应 SDK 能力 |
| --- | --- | --- |
| `storage:read` | 基础 | `sdk.docs.get/query`、`sdk.db` 读 |
| `storage:write` | 基础 | `sdk.docs.put/delete`、`sdk.db` 写 |
| `org:read` | 基础 | `sdk.runtime.listMineOrganizations()` |
| `proof:verify` | 基础 | `sdk.evidence.headHash/verify` |
| `org:sync` | 高级 | `sdk.runtime.syncOrganizationData(orgId)` |
| `network:broadcast` | 高级 | `sdk.p2p.broadcast(topic, message)` |
| `identity:sign` | 高级 | `sdk.identity.sign(payload)` |

### 3.2 声明与授权

- 插件在 manifest 中声明所需高级权限，例如 weibo-core：`"permissions": ["org:sync"]`。
- 安装时系统向用户展示声明的高级权限清单，确认后方安装并落库授权。
- 未声明/未授权的高级能力在运行时调用会被主进程拒绝（`Access denied: permission "xxx" is not granted`）。
- 注意：`sdk.identity.verify` 为纯验签函数，不含敏感数据，无需权限。

## 4. 组织内插件数据同步策略

### 4.1 默认自动同步

当组织成员同步组织数据时，系统会自动收集并同步符合以下条件的插件文档：

- 文档键属于插件域（doc:plugin:...）。
- 文档中包含 orgId 字段。
- 文档的 orgId 与目标组织一致。
- 文档未显式声明为不同步。

这意味着：只要你的插件文档是组织作用域数据（带 orgId），默认就会自动同步给同组织成员，无需额外编码。

### 4.2 显式不同步声明（本地数据）

如果某条文档不应同步，需要在文档内显式声明。支持以下形式之一：

- __sync: false
- __sync: { "disabled": true }
- __sync: { "mode": "local" }
- __sync: { "strategy": "local" }

建议：

- 用户草稿、临时 UI 状态、仅本机缓存内容应显式标记不同步。
- 组织业务数据（帖子、评论、配置等）不要加不同步标记。

## 5. SDK 接口说明

插件侧通过 initializePluginSDK() 获取 SDK 实例。核心接口如下。

### 5.1 sdk.domain

- 类型：string
- 含义：当前插件域身份（由主进程绑定，不可由渲染层伪造）

### 5.2 sdk.db（底层数据库接口）

- open(): 打开数据库
- close(): 关闭数据库
- get(key): 读取键值
- put(key, value): 写入键值
- del(key): 删除键
- batch(operations): 批量操作
- query(prefix): 前缀查询
- path(): 获取数据库路径
- status(): 获取打开状态

说明：这是底层接口，通常优先使用 sdk.docs。

### 5.3 sdk.docs（推荐：插件文档接口）

- get(collection, id): 获取文档
- put(collection, id, doc): 写入文档
- delete(collection, id): 删除文档
- query(collection, options): 查询文档

特点：

- 自动走插件域隔离。
- 自动携带同步所需元信息。
- 与组织内默认同步策略协同工作。

### 5.4 sdk.runtime（运行时上下文）

- currentRoot(): 获取当前 Root 身份状态
- listMineOrganizations(): 列出当前用户所属组织
- syncOrganizationData(orgId): 主动向组织内其他成员节点拉取指定组织的最新数据（高级权限 `org:sync`）

常见用途：

- 过滤当前插件可见组织。
- 进行管理员/成员权限分支。
- 打开组织页面时主动同步一次，保证数据新鲜。

### 5.5 sdk.identity（域身份能力）

- sign(payload): 使用当前插件域身份对数据签名（高级权限 `identity:sign`）。返回 `{ domain, domainId, publicKey, signature, payloadHash }`。
- verify(payload, signature, publicKey): 校验 Ed25519 签名，返回 `{ valid }`。纯函数，无需权限。

安全说明：

- 签名使用的是**域身份私钥**，由主进程从根种子即时派生，永不离开主进程；插件与渲染层拿不到任何私钥。
- 不同域的域身份公钥不可关联，签名只能证明"某成员在该插件域内发起过此操作"。
- 跨节点验签：把 `publicKey` 与 `signature` 随业务数据一起存储/同步，其他成员节点用 verify 校验。

### 5.6 sdk.p2p（网络能力）

- start(): 启动 p2p
- stop(): 停止 p2p
- broadcast(topic, message): 发布消息（高级权限 `network:broadcast`）

说明：大多数插件业务不需要直接调用 broadcast，优先使用 sdk.docs 让系统自动处理数据同步。

### 5.7 sdk.evidence（证据链能力）

- headHash(): 获取证据头哈希
- verify(): 校验证据链

适用场景：需要审计、可验证一致性的业务。

## 6. 插件数据设计建议

- 所有组织作用域数据都应包含 orgId 字段。
- 文档主键保持稳定且可重建（如 post_xxx、comment_xxx）。
- 权限控制在业务层实现（例如管理员可发帖，成员可评论）。
- 需要防抵赖的操作（投票、签名）使用 sdk.identity.sign 签名后再写入。
- 同步默认开启，不同步数据必须显式声明。

## 7. 最小开发清单

1. 定义插件 manifest（id、domain、version、entryView，以及所需高级权限 permissions）。
2. 在视图初始化时获取 SDK。
3. 基于 sdk.runtime.listMineOrganizations() 选择组织上下文。
4. 业务数据通过 sdk.docs 读写，并附带 orgId。
5. 仅对本地草稿类数据增加 __sync 不同步声明。

## 8. 常见问题

### Q1：为什么我写入了数据，其他成员看不到？

优先检查：

- 文档是否包含正确的 orgId。
- 是否误加了 __sync 不同步标记。
- 目标成员是否已加入组织并完成组织同步。

### Q2：是否每新增一个业务字段都要改同步代码？

不需要。组织与插件数据同步已采用通用策略：默认自动同步，显式声明才排除。

### Q3：调用 SDK 报 "permission xxx is not granted"？

该能力属于高级权限，需要在 manifest 的 permissions 中声明，并在安装时完成授权；已安装的插件补声明后需重新安装/升级才会更新授权。
