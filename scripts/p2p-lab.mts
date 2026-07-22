/**
 * P2P 本地实验室：单进程起多个真实 P2PNode（独立 LevelDB 目录、独立端口、独立身份），
 * 不需要多台 PC 即可联调组织与覆盖网全流程。
 *
 * 用法：
 *   npm run p2p:lab -- <scenario>
 *
 * 场景：
 *   overlay   覆盖网基础：connect 沉淀 / peer-exchange / node-announce / org-recovery 协议
 *   invite    组织邀请码加入全流程：建组织 → 预录成员 → 邀请码加入 → claim 回填 →  gossip 扩散
 *   recovery  组织失联后覆盖网恢复：管理员与成员换地址重启，离线成员经桥接节点定向找回
 *   interop   TS↔Rust 互通收官实验：yamux 协商 / gossipsub 互见 / 双向签名 update /
 *             node-announce 双向 / peer-exchange 双向（驱动 code/core 的 lab_node 例程）
 *
 * 每个节点使用临时目录（os.tmpdir 下），运行结束自动清理。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import nacl from 'tweetnacl';
import { Level } from 'level';
import { P2PNode } from '../src/main/p2p/p2p-node.js';
import { OrganizationService, buildNodeInfoClaimPayload, type NodeInfoClaim } from '../src/main/organization/index.js';
import { sha256Hex } from '../src/main/identity/root-id.js';
import { activeRecoveryTokens } from '../src/main/p2p/org-recovery.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const labRoot = mkdtempSync(path.join(tmpdir(), 'spark-p2p-lab-'));
let exitCode = 0;

function log(...args: unknown[]) {
  console.log('[lab]', ...args);
}

function fail(message: string): never {
  throw new Error(message);
}

/** 独立 LevelDB 实例（真实持久化，重启保留身份与数据） */
class LabDb {
  private inner: Level<string, string>;
  opened = false;

  constructor(dir: string) {
    this.inner = new Level<string, string>(dir, { valueEncoding: 'utf8' });
  }

  async open(): Promise<void> {
    await this.inner.open();
    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.opened) {
      await this.inner.close();
      this.opened = false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.inner.get(key);
    } catch {
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.inner.put(key, value);
  }

  async batch(operations: Array<{ type: 'put' | 'del'; key: string; value?: string }>): Promise<void> {
    await this.inner.batch(operations as never);
  }

  async del(key: string): Promise<void> {
    try {
      await this.inner.del(key);
    } catch {
      // 忽略不存在
    }
  }

  async queryRange(options: { prefix: string }): Promise<Array<{ key: string; value: string }>> {
    const rows: Array<{ key: string; value: string }> = [];
    for await (const [key, value] of this.inner.iterator({ gte: options.prefix, lt: `${options.prefix}\xFF` })) {
      rows.push({ key, value });
    }
    return rows;
  }
}

/** 实验身份：tweetnacl Ed25519 密钥对，rootId = sha256(公钥)，持久化到目录 */
class LabIdentity {
  readonly rootId: string;
  readonly publicKeyBase64: string;
  private readonly secretKey: Uint8Array;

  constructor(dir: string) {
    const file = path.join(dir, 'identity.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.publicKeyBase64 = saved.publicKey;
      this.secretKey = Buffer.from(saved.secretKey, 'base64');
    } else {
      const keyPair = nacl.sign.keyPair();
      this.publicKeyBase64 = Buffer.from(keyPair.publicKey).toString('base64');
      this.secretKey = keyPair.secretKey;
      writeFileSync(file, JSON.stringify({ publicKey: this.publicKeyBase64, secretKey: Buffer.from(this.secretKey).toString('base64') }));
    }
    this.rootId = sha256Hex(Buffer.from(this.publicKeyBase64, 'base64'));
  }

  sign(payload: string): string {
    const signature = nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), new Uint8Array(this.secretKey));
    return Buffer.from(signature).toString('base64');
  }
}

/** 一个实验节点：LevelDB + 身份 + P2PNode + OrganizationService（装配口径同 bootstrap.ts） */
class LabNode {
  readonly dir: string;
  private db!: LabDb;
  identity!: LabIdentity;
  p2p!: P2PNode;
  orgs!: OrganizationService;
  /** 直连版本探测观察记录（/spark/version/1.0.0 对端 appVersion） */
  readonly observedPeerVersions: Array<{ version: string; peerId: string }> = [];

  constructor(readonly name: string, private port: number) {
    this.dir = path.join(labRoot, name);
  }

  get peerId(): string {
    return this.p2p.nodeId;
  }

  get wsAddr(): string {
    return `/ip4/127.0.0.1/tcp/${this.port}/ws/p2p/${this.peerId}`;
  }

  async start(): Promise<void> {
    this.db = new LabDb(path.join(this.dir, 'leveldb'));
    await this.db.open();
    this.identity = new LabIdentity(this.dir);
    await this.db.put('p2p:listen:wsPort', String(this.port));

    const rootIdentity = { getCurrentRootId: async () => this.identity.rootId };
    this.orgs = new OrganizationService(this.db as never, rootIdentity, {
      syncOrganizationToMember: async ({ organization, member, targetRootId }) => {
        if (!member.nodeInfo) {
          throw new Error('Member node info is required for p2p sync');
        }
        await this.p2p.syncOrganizationToMember(member.nodeInfo, targetRootId, organization);
      }
    }, {
      getLocalNodeInfo: async () => {
        const info = this.p2p.getLocalNodeInfo();
        return { peerId: info.peerId, addresses: info.addresses };
      },
      connectAndPull: async (nodeInfo, extras) => {
        const result = await this.p2p.pullOrganizationsFromPeer(nodeInfo, extras);
        return { pulled: result.pulled };
      },
      buildSelfNodeInfoClaim: async () => this.buildSelfClaim()
    });
    this.p2p = new P2PNode(this.db as never, rootIdentity, {
      appVersion: 'p2p-lab',
      onPeerVersionObserved: async (version, peerId) => {
        this.observedPeerVersions.push({ version, peerId });
      },
      onNodeInfoClaim: async (claim, context) => {
        await this.orgs.applyNodeInfoClaim(claim as NodeInfoClaim, context);
      },
      getSelfNodeInfoClaim: async () => this.buildSelfClaim(),
      getRecoveryView: async () => this.orgs.getRecoveryView()
    });
    await this.p2p.start();
    log(`节点 ${this.name} 已启动 peerId=${this.peerId.slice(0, 16)}… rootId=${this.identity.rootId.slice(0, 8)}… port=${this.port}`);
  }

  async stop(): Promise<void> {
    await this.p2p.stop();
    await this.db.close();
    log(`节点 ${this.name} 已停止`);
  }

  /** 换端口重启（同一目录 → 同一身份与 peerId，地址变化，模拟家用宽带 IP 更换） */
  async restartWithNewPort(newPort: number): Promise<void> {
    await this.stop();
    this.port = newPort;
    await this.start();
  }

  private async buildSelfClaim(): Promise<NodeInfoClaim | null> {
    const local = this.p2p.getLocalNodeInfo();
    if (!local.started || !local.peerId) {
      return null;
    }
    const unsigned = {
      type: 'spark-node-info-claim' as const,
      version: 1 as const,
      rootId: this.identity.rootId,
      publicKey: this.identity.publicKeyBase64,
      nodeInfo: { peerId: local.peerId, addresses: local.addresses },
      timestamp: Date.now()
    };
    return { ...unsigned, signature: this.identity.sign(buildNodeInfoClaimPayload(unsigned)) };
  }

  overlayPool() {
    return (this.p2p as any).overlayPeers as import('../src/main/p2p/overlay-peer-store.js').OverlayPeerStore;
  }

  recovery() {
    return (this.p2p as any).orgRecovery as import('../src/main/p2p/org-recovery.js').OrgRecoveryService;
  }

  connectedPeerIds(): string[] {
    return this.p2p.getLocalNodeInfo().connectedPeers;
  }

  /** 直读底层存储（interop 场景验证生产 applyRemoteUpdate 真实落库） */
  async dbGet(key: string): Promise<string | null> {
    return this.db.get(key);
  }
}

async function cleanup(): Promise<void> {
  rmSync(labRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 场景 overlay：覆盖网四机制基础验证（双节点）
// ---------------------------------------------------------------------------
async function scenarioOverlay(): Promise<void> {
  // 已启动列表逐个回收：任一节点 start 抛错时，先前已启动的节点也会被停止
  const started: LabNode[] = [];
  const boot = async (node: LabNode): Promise<LabNode> => {
    await node.start();
    started.push(node);
    return node;
  };
  try {
    const a = await boot(new LabNode('A', 16101));
    const b = await boot(new LabNode('B', 16102));
    // 1) 直连沉淀
    await b.p2p.connectPeer({ peerId: a.peerId, addresses: [a.wsAddr] });
    await sleep(1200);
    const inA = (await a.overlayPool().listAll()).find((e) => e.peerId === b.peerId);
    const inB = (await b.overlayPool().listAll()).find((e) => e.peerId === a.peerId);
    if (!inA || !inB) fail(`连接沉淀失败 inA=${!!inA} inB=${!!inB}`);
    log('✓ 1/4 connect 沉淀双向生效');

    // 2) peer-exchange：B 持有第三方线索，A 经 tick 学到
    const hint = 'QmLabThirdHintPeer000000000000000000000000000';
    await b.overlayPool().remember(hint, ['/ip4/127.0.0.1/tcp/9999/ws'], 'announce', true);
    await a.p2p.maintainOverlayNetwork();
    const learned = (await a.overlayPool().listAll()).find((e) => e.peerId === hint);
    if (!learned || learned.source !== 'exchange' || learned.verified) fail(`exchange 入池异常：${JSON.stringify(learned)}`);
    log('✓ 2/4 peer-exchange 学到线索（未验证入池）');

    // 3) node-announce 验签
    let verified = false;
    for (let i = 0; i < 8 && !verified; i += 1) {
      await (b.p2p as any).nodeAnnounce.publishOwnAnnounce();
      await sleep(1200);
      const entry = (await a.overlayPool().listAll()).find((e) => e.peerId === b.peerId);
      verified = entry?.verified === true && entry.source === 'announce';
    }
    if (!verified) fail('A 未观察到 B 的已验证公告');
    log('✓ 3/4 node-announce 验签通过并升级邻居池条目');

    // 4) org-recovery 协议：A 建组织并预录 B（带 nodeInfo），B 凭恢复 token 查询命中
    const org = await a.orgs.createOrganization({ name: '覆盖网测试组织', description: 'lab', basePluginDomain: 'plugin:weibo' });
    await a.orgs.addMember(org.orgId, { rootId: b.identity.rootId, nodeInfo: { peerId: b.peerId, addresses: [b.wsAddr] } });
    const view = await a.orgs.getRecoveryView();
    if (view.length === 0) fail('A 无组织恢复视图');
    const token = activeRecoveryTokens(view[0]!.orgId, view[0]!.recoverySecret)[0];
    const found = await b.recovery().queryRecovery(token, [a.peerId]);
    if (!found.some((c) => c.peerId === b.peerId)) fail(`recovery 未命中：${JSON.stringify(found)}`);
    log('✓ 4/4 org-recovery 查询命中候选成员');
  } finally {
    for (const node of [...started].reverse()) {
      await node.stop().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// 场景 invite：组织邀请码加入全流程（双节点）
// ---------------------------------------------------------------------------
async function scenarioInvite(): Promise<void> {
  const started: LabNode[] = [];
  const boot = async (node: LabNode): Promise<LabNode> => {
    await node.start();
    started.push(node);
    return node;
  };
  try {
    const a = await boot(new LabNode('A-admin', 16111));
    const b = await boot(new LabNode('B-member', 16112));
    // 1) 管理员创建组织
    const org = await a.orgs.createOrganization({ name: '阳光小区业委会', description: 'lab 联调', basePluginDomain: 'plugin:weibo' });
    log(`组织已创建 orgId=${org.orgId}`);

    // 2) 预录成员 RootID（无 nodeInfo，凭邀请码上线后回拉）
    await a.orgs.addMember(org.orgId, { rootId: b.identity.rootId });
    log('已预录成员 B 的 RootID');

    // 3) 生成邀请码（携带 A 的节点地址）
    const { invite } = await a.orgs.createOrgInvite(org.orgId);
    log(`邀请码已生成（${invite.length} 字符）`);

    // 4) B 凭码加入：直连 A → 反熵拉取 → 捎带签名 claim
    const joined = await b.orgs.acceptOrgInvite(invite);
    log(`B 已加入组织：${joined.orgName}（${joined.memberCount} 名成员）`);

    // 5) 断言：B 本地有组织记录且是成员
    const bOrgs = await b.orgs.listMine();
    if (!bOrgs.some((item) => item.orgId === org.orgId)) fail('B 本地未见组织记录');

    // 6) 断言：A 侧已回填 B 的 nodeInfo（claim 验签落库）
    await sleep(1000);
    const aOrgs = await a.orgs.listMine();
    const bMember = aOrgs[0]?.members.find((member) => member.rootId === b.identity.rootId);
    if (bMember?.nodeInfo?.peerId !== b.peerId) fail(`A 未回填 B 的 nodeInfo：${JSON.stringify(bMember?.nodeInfo)}`);
    log('✓ claim 验签通过，A 已回填 B 的节点地址');

    // 7) 断言：K 副本概览可见（A 视角成员同步状态）
    const overview = await a.p2p.getOrgSyncOverview(org.orgId);
    log(`副本概览：syncedPeers=${overview?.syncedPeers}/${overview?.replicaTarget}`);
  } finally {
    for (const node of [...started].reverse()) {
      await node.stop().catch(() => {});
    }
  }
  log('✓ invite 场景全部通过');
}

// ---------------------------------------------------------------------------
// 场景 recovery：组织失联后覆盖网恢复（四节点：A 管理员、D/B 成员、C 桥接）
// ---------------------------------------------------------------------------
async function scenarioRecovery(): Promise<void> {
  const started: LabNode[] = [];
  const boot = async (node: LabNode): Promise<LabNode> => {
    await node.start();
    started.push(node);
    return node;
  };
  try {
    const a = await boot(new LabNode('A-admin', 16121));
    const d = await boot(new LabNode('D-member', 16122));
    const b = await boot(new LabNode('B-member', 16123));
    const c = await boot(new LabNode('C-bridge', 16124));
    // 1) 建组织 + 预录 D、B；两者凭邀请码加入
    const org = await a.orgs.createOrganization({ name: '临江花园业委会', description: 'lab 联调', basePluginDomain: 'plugin:weibo' });
    await a.orgs.addMember(org.orgId, { rootId: d.identity.rootId });
    await a.orgs.addMember(org.orgId, { rootId: b.identity.rootId });
    const { invite } = await a.orgs.createOrgInvite(org.orgId);
    await d.orgs.acceptOrgInvite(invite);
    await b.orgs.acceptOrgInvite(invite);
    await sleep(800);
    log('D、B 均已凭邀请码加入组织');

    // 2) A、D 换端口重启（模拟公网地址变化）；B、C 保持运行
    await a.restartWithNewPort(16131);
    await d.restartWithNewPort(16132);
    log('A、D 已换地址重启（peerId 不变，旧地址失效）');

    // B 直连 A 的旧地址应当失败（证明旧地址已失效）
    let staleDialFailed = false;
    try {
      await b.p2p.connectPeer({ peerId: a.peerId, addresses: ['/ip4/127.0.0.1/tcp/16121/ws/p2p/' + a.peerId] });
    } catch {
      staleDialFailed = true;
    }
    if (!staleDialFailed) fail('B 拨 A 旧地址未失败，场景前提不成立');
    log('✓ 1/4 B 持有的组织成员旧地址已全部失效');

    // 3) D 经桥接 C 找到 A（操作员视角直连），并向 A 重宣告新地址（claim 回填）
    await d.p2p.connectPeer({ peerId: c.peerId, addresses: [c.wsAddr] });
    await a.p2p.connectPeer({ peerId: c.peerId, addresses: [c.wsAddr] });
    await sleep(800);
    await d.p2p.pullOrganizationsFromPeer({ peerId: a.peerId, addresses: [a.wsAddr] }, {
      nodeInfoClaim: await (d as any).buildSelfClaim()
    });
    await sleep(800);
    log('D 已重新连上 A 并重宣告新地址（A 的组织记录已含 D 的新地址）');

    // 4) B 只连桥接 C，经 org-recovery 查询找到 D 的新地址
    await b.p2p.connectPeer({ peerId: c.peerId, addresses: [c.wsAddr] });
    await sleep(800);
    const view = await b.orgs.getRecoveryView();
    if (view.length === 0) fail('B 无组织恢复视图');
    const token = activeRecoveryTokens(view[0]!.orgId, view[0]!.recoverySecret)[0];
    const found = await b.recovery().queryRecovery(token, [c.peerId]);
    const hitD = found.find((item) => item.peerId === d.peerId);
    if (!hitD) fail(`恢复查询未命中 D：${JSON.stringify(found)}`);
    log(`✓ 2/4 B 经 C 转发命中 D 的新地址（${hitD.addresses[0]}）`);

    // 5) B 拨 D 新地址并回拉组织数据（组织链路恢复）
    await b.p2p.connectPeer(hitD);
    const pulled = await b.p2p.pullOrganizationsFromPeer(hitD, { nodeInfoClaim: await (b as any).buildSelfClaim() });
    if (pulled.pulled < 1) fail('B 回拉组织数据失败');
    log('✓ 3/4 B 已连上 D 并完成组织数据回拉');

    // 6) node-announce 沿覆盖网多跳到达：B 应能从池里看到 A 的新地址（经 C 转发公告）
    let sawFreshA = false;
    for (let i = 0; i < 8 && !sawFreshA; i += 1) {
      await (a.p2p as any).nodeAnnounce.publishOwnAnnounce();
      await sleep(1200);
      const entry = (await b.overlayPool().listAll()).find((e) => e.peerId === a.peerId);
      sawFreshA = entry?.verified === true && entry.addresses.some((addr) => addr.includes('/tcp/16131/'));
    }
    if (!sawFreshA) fail('B 未收到 A 的新地址公告');
    log('✓ 4/4 A 的新地址公告经覆盖网多跳到达 B（verified）');
  } finally {
    for (const node of [...started].reverse()) {
      await node.stop().catch(() => {});
    }
  }
  log('✓ recovery 场景全部通过');
}

// ---------------------------------------------------------------------------
// 场景 interop：TS↔Rust 真实互通（驱动 code/core 的 lab_node 例程）
// ---------------------------------------------------------------------------

/** 轮询直到条件成立，超时即失败。 */
async function pollUntil(pred: () => boolean | Promise<boolean>, timeoutMs: number, desc: string, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(intervalMs);
  }
  fail(`超时：${desc}`);
}

/** 定位 code/core（npm run 时 cwd=desktop；兜底按本文件位置反推）。 */
function resolveCoreDir(): string {
  const candidates = [
    path.resolve(process.cwd(), '../code/core'),
    path.resolve(new URL('.', import.meta.url).pathname, '../../../code/core')
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'Cargo.toml'))) return candidate;
  }
  fail(`找不到 code/core（尝试：${candidates.join(', ')}）`);
}

/**
 * Rust lab_node 子进程驱动：stdio JSON 行协议。
 * 协议见 code/core/examples/lab_node.rs 头注释。
 */
class RustLabNode {
  peerId = '';
  wsAddr = '';

  private proc!: ReturnType<typeof spawn>;
  private cmdSeq = 0;
  private readonly buffer: any[] = [];
  private readonly waiters: Array<{ pred: (msg: any) => boolean; resolve: (msg: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  private readonly pendingCmds = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private exited = false;

  static async start(port: number): Promise<RustLabNode> {
    const coreDir = resolveCoreDir();
    const binary = path.join(coreDir, 'target/debug/examples/lab_node');
    if (!existsSync(binary)) {
      log('lab_node 二进制缺失，先执行 cargo build --example lab_node …');
      const env = { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH ?? ''}` };
      const build = spawnSync('cargo', ['build', '--example', 'lab_node'], { cwd: coreDir, env, stdio: 'inherit' });
      if (build.status !== 0) fail('cargo build --example lab_node 失败');
    }
    const node = new RustLabNode();
    node.proc = spawn(binary, ['--port', String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
    node.proc.on('exit', (code) => {
      node.exited = true;
      const err = new Error(`rust lab_node 意外退出 code=${code}`);
      for (const waiter of node.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      for (const [, pending] of node.pendingCmds) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      node.pendingCmds.clear();
    });
    const rl = createInterface({ input: node.proc.stdout! });
    rl.on('line', (line) => node.onLine(line));
    const ready = await node.waitFor((msg) => msg.type === 'ready', 20000, '等待 rust 节点 ready');
    node.peerId = ready.peerId;
    const ws = (ready.addresses as string[]).find((addr) => addr.includes('/ws'));
    if (!ws) fail(`rust 节点无 ws 监听地址：${JSON.stringify(ready.addresses)}`);
    node.wsAddr = ws;
    log(`rust lab_node 已启动 peerId=${node.peerId.slice(0, 16)}… ws=${ws}`);
    return node;
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'result' && typeof msg.id === 'number') {
      const pending = this.pendingCmds.get(msg.id);
      if (pending) {
        this.pendingCmds.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(String(msg.error)));
        return;
      }
    }
    this.buffer.push(msg);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i]!;
      if (waiter.pred(msg)) {
        this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  }

  /** 等待一条匹配行（先查缓冲，再等新行）；超时 reject。 */
  waitFor(pred: (msg: any) => boolean, timeoutMs: number, desc: string): Promise<any> {
    const hit = this.buffer.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`等待 rust 输出超时：${desc}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  /** 发送命令并等待 result。 */
  cmd(command: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
    if (this.exited) return Promise.reject(new Error('rust lab_node 已退出'));
    const id = ++this.cmdSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(id);
        reject(new Error(`rust 命令超时：${JSON.stringify(command)}`));
      }, timeoutMs);
      this.pendingCmds.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  async overlayPool(): Promise<any[]> {
    return await this.cmd({ cmd: 'overlay-pool' });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      await this.cmd({ cmd: 'shutdown' }, 5000);
    } catch {
      // 已退出也接受
    }
    if (!this.exited) {
      this.proc.kill('SIGKILL');
    }
  }
}

async function scenarioInterop(): Promise<void> {
  // console.warn 探针：签名类丢弃是互通失败信号，其余告警（版本探测重试等）只记录不失败
  const signatureWarnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const text = args.map((arg) => String(arg)).join(' ');
    if (text.includes('signature invalid') || text.includes('unsigned data message')) {
      signatureWarnings.push(text);
    }
    originalWarn.apply(console, args);
  };

  const rust = await RustLabNode.start(0);
  const ts = new LabNode('TS-interop', 16141);
  try {
    await ts.start();

    // ----- 场景 A：互连 + yamux 协商 + gossipsub topic 互见 -----
    await ts.p2p.connectPeer({ peerId: rust.peerId, addresses: [rust.wsAddr] });
    await pollUntil(() => ts.connectedPeerIds().includes(rust.peerId), 10000, 'TS 侧未见 rust 连接');
    await rust.waitFor((msg) => msg.type === 'event' && msg.event === 'peer-connected' && msg.peerId === ts.peerId, 10000, 'rust 侧未见 TS 连接');

    // yamux 协商证据：TS 连接对象的 multiplexer 字段
    const conn = (ts.p2p as any).node.getConnections().find((item: any) => item?.remotePeer?.toString?.() === rust.peerId);
    const muxer = conn?.multiplexer ?? 'unknown';
    if (muxer !== '/yamux/1.0.0') fail(`muxer 协商结果异常：${muxer}（连接属性：${JSON.stringify(Object.keys(conn ?? {}))}）`);
    log(`✓ A1 连接建立，muxer=${muxer}（rust-libp2p 仅支持 yamux，协商成功即证明 yamux 链路）`);

    await pollUntil(() => ts.p2p.getLocalNodeInfo().sparkSyncSubscribers.includes(rust.peerId), 15000, 'TS 未见 rust 订阅 spark-sync');
    await pollUntil(async () => (await rust.cmd({ cmd: 'info' })).sparkSyncSubscribers.includes(ts.peerId), 15000, 'rust 未见 TS 订阅 spark-sync');
    log('✓ A2 gossipsub spark-sync topic 双向互相可见');

    // 版本探测双向（附检 /spark/version/1.0.0 直连协议）
    await pollUntil(() => ts.observedPeerVersions.some((item) => item.version === 'rust-lab-node'), 10000, 'TS 未观察到 rust appVersion');
    await rust.waitFor((msg) => msg.type === 'event' && msg.event === 'peer-version' && msg.appVersion === 'p2p-lab', 10000, 'rust 未观察到 TS appVersion');
    log('✓ A3 /spark/version/1.0.0 版本探测双向成功');

    // ----- 场景 B：双向签名 update（TS=PEM pubKey，Rust=SPKI DER base64 pubKey） -----
    const tsMeta = { vv: { [ts.peerId]: 1 }, ts: Date.now(), nodeId: ts.peerId };
    let applied: any = null;
    const tsSendDeadline = Date.now() + 15000;
    while (!applied && Date.now() < tsSendDeadline) {
      await ts.p2p.broadcast('spark-sync', {
        type: 'update',
        domain: 'interop',
        collection: 'items',
        id: 'ts-doc-1',
        payload: { text: 'hello from ts' },
        meta: tsMeta
      });
      applied = await rust
        .waitFor((msg) => msg.type === 'applied' && msg.id === 'ts-doc-1', 1500, 'rust 应用 TS update')
        .catch(() => null);
    }
    if (!applied) fail('rust 未在期限内应用 TS 的签名 update');
    if (applied.domain !== 'interop' || applied.collection !== 'items' || applied.payload?.text !== 'hello from ts') {
      fail(`rust 侧落库内容不符：${JSON.stringify(applied)}`);
    }
    log('✓ B1 TS 签名 update → rust 验签通过并触发落库回调');

    // rust→TS：挂观察者抓原始信封，用生产 verifySignature 复核（走 DER base64 新路径）
    const pubsub = (ts.p2p as any).node.services.pubsub;
    let captured: any = null;
    const observer = (raw: any) => {
      const msg = raw?.detail ?? raw;
      if (msg?.topic !== 'spark-sync') return;
      try {
        const parsed = JSON.parse(Buffer.from(msg.data).toString('utf8'));
        if (parsed?.type === 'update' && parsed?.id === 'rust-doc-1') captured = parsed;
      } catch {
        // 非目标消息
      }
    };
    pubsub.addEventListener('message', observer);
    const rustSendDeadline = Date.now() + 15000;
    while (!captured && Date.now() < rustSendDeadline) {
      await rust.cmd({ cmd: 'broadcast-update', domain: 'interop', collection: 'items', docId: 'rust-doc-1', payload: { text: 'hello from rust' } }).catch(() => null);
      await sleep(700);
    }
    pubsub.removeEventListener('message', observer);
    if (!captured) fail('TS 未在期限内收到 rust 的 update');
    if (typeof captured.pubKey !== 'string' || captured.pubKey.includes('BEGIN PUBLIC KEY')) {
      fail(`rust pubKey 线形异常（应为 SPKI DER base64）：${String(captured.pubKey).slice(0, 60)}`);
    }
    const verifyOk = (ts.p2p as any).verifySignature(captured, captured.pubKey, captured.signature);
    if (!verifyOk) fail('TS 生产 verifySignature 对 rust DER 信封验签失败');
    if (signatureWarnings.length > 0) fail(`TS 侧出现签名丢弃告警：${signatureWarnings.join(' | ')}`);
    log('✓ B2 rust 签名 update（DER base64 pubKey）→ TS 生产验签路径通过且无丢弃');

    // 生产落库链路实证：handler 内部 applyRemoteUpdate 写入 doc:interop:items:rust-doc-1
    await pollUntil(async () => (await ts.dbGet('doc:interop:items:rust-doc-1')) !== null, 8000, 'TS 未落库 rust-doc-1');
    const stored = await ts.dbGet('doc:interop:items:rust-doc-1');
    if (!stored || !stored.includes('hello from rust')) fail(`TS 落库内容不符：${stored}`);
    log('✓ B3 rust update 经 TS 生产 applyRemoteUpdate 链路真实落库');

    // ----- 场景 C：node-announce 双向交换 -----
    await rust.cmd({ cmd: 'announce' });
    await pollUntil(async () => {
      const entry = (await ts.overlayPool().listAll()).find((item) => item.peerId === rust.peerId);
      return entry?.verified === true && entry.source === 'announce';
    }, 15000, 'TS 未接受 rust 的签名 announce');
    log('✓ C1 rust node-announce → TS 验签通过并 verified 入池');

    await (ts.p2p as any).nodeAnnounce.publishOwnAnnounce();
    await pollUntil(async () => {
      const entry = (await rust.overlayPool()).find((item: any) => item.peerId === ts.peerId);
      return entry?.verified === true;
    }, 15000, 'rust 未接受 TS 的签名 announce');
    await rust.waitFor((msg) => msg.type === 'event' && msg.event === 'announce-accepted' && msg.peerId === ts.peerId, 5000, 'rust 未发 AnnounceAccepted 事件');
    log('✓ C2 TS node-announce → rust 验签通过并 verified 入池');

    // ----- 场景 D：peer-exchange 双向请求响应 -----
    const hintForRust = 'QmLabInteropHintForRust000000000000000000000';
    await ts.overlayPool().remember(hintForRust, ['/ip4/127.0.0.1/tcp/19998/ws'], 'announce', true);
    const rustExchange = await rust.cmd({ cmd: 'exchange', peerId: ts.peerId });
    if (!(rustExchange?.merged >= 1)) fail(`rust→TS exchange 合并数异常：${JSON.stringify(rustExchange)}`);
    await pollUntil(async () => {
      const entry = (await rust.overlayPool()).find((item: any) => item.peerId === hintForRust);
      return entry?.source === 'exchange' && entry?.verified === false;
    }, 8000, 'rust 池内未见 exchange 线索');
    log('✓ D1 rust 发起 peer-exchange → TS 响应 → rust 未验证入池');

    const hintForTs = 'QmLabInteropHintForTs0000000000000000000000';
    await rust.cmd({ cmd: 'seed-overlay', peerId: hintForTs, addresses: ['/ip4/127.0.0.1/tcp/19999/ws'], verified: true });
    const merged = await (ts.p2p as any).peerExchange.exchangeWithPeer(rust.peerId);
    if (!(merged >= 1)) fail(`TS→rust exchange 合并数异常：${merged}`);
    const learned = (await ts.overlayPool().listAll()).find((item) => item.peerId === hintForTs);
    if (!learned || learned.source !== 'exchange' || learned.verified) fail(`TS 池内 exchange 线索异常：${JSON.stringify(learned)}`);
    log('✓ D2 TS 发起 peer-exchange → rust 响应 → TS 未验证入池');
  } finally {
    console.warn = originalWarn;
    await rust.stop().catch(() => {});
    await ts.stop().catch(() => {});
  }
  log('✓ interop 场景全部通过');
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const scenario = process.argv[2] ?? 'overlay';
  log(`实验目录：${labRoot}`);
  const scenarios: Record<string, () => Promise<void>> = {
    overlay: scenarioOverlay,
    invite: scenarioInvite,
    recovery: scenarioRecovery,
    interop: scenarioInterop
  };
  const run = scenarios[scenario];
  if (!run) {
    fail(`未知场景 "${scenario}"，可选：${Object.keys(scenarios).join(' | ')}`);
  }
  await run();
  log(`场景 ${scenario} 通过 ✓`);
}

main()
  .then(() => cleanup())
  .catch((error) => {
    exitCode = 1;
    console.error('[lab] 失败：', error instanceof Error ? error.message : error);
    return cleanup();
  })
  .finally(() => {
    process.exit(exitCode);
  });
