import net from 'net';

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const DEFAULT_PORT_SCAN_RANGE = 50;

export function parseWsListenPort(addresses: string[]): number | null {
  for (const address of addresses) {
    const match = address.match(/\/tcp\/(\d+)\/ws(?:\/|$)/);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed >= MIN_PORT && parsed <= MAX_PORT) {
      return parsed;
    }
  }

  return null;
}

export function normalizePreferredPort(value: unknown, fallbackPort: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (Number.isInteger(parsed) && parsed >= MIN_PORT && parsed <= MAX_PORT) {
    return parsed;
  }
  return fallbackPort;
}

async function probeBind(port: number, host: string, ipv6Only = false): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host, ipv6Only });
  });
}

/**
 * 端口可用性探测。ipv6 为 true 时同时验证 IPv6 通配地址（ipv6Only 语义，
 * 与 libp2p WS listener 的实际绑定方式一致）——避免"端口被 IPv6-only 进程
 * 占用但 IPv4 可绑"时误判可用，导致双栈监听在启动阶段 EADDRINUSE。
 */
export async function isTcpPortAvailable(port: number, ipv6 = false): Promise<boolean> {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return false;
  }

  if (!(await probeBind(port, '0.0.0.0'))) {
    return false;
  }
  if (ipv6 && !(await probeBind(port, '::', true))) {
    return false;
  }
  return true;
}

export async function pickListenPort(preferredPort: number, scanRange = DEFAULT_PORT_SCAN_RANGE, ipv6 = false): Promise<number> {
  const normalizedPreferred = normalizePreferredPort(preferredPort, preferredPort);
  const candidates: number[] = [];
  for (let offset = 0; offset <= Math.max(0, scanRange); offset += 1) {
    const next = normalizedPreferred + offset;
    if (next > MAX_PORT) {
      break;
    }
    candidates.push(next);
  }

  for (const port of candidates) {
    if (await isTcpPortAvailable(port, ipv6)) {
      return port;
    }
  }

  // As a last resort, allow OS to allocate an ephemeral port.
  return 0;
}

/**
 * 探测 OS 是否可绑定 IPv6 通配地址。
 * IPv6 被禁用（少数精简/老旧系统）时双栈监听会导致启动失败，据此回退 IPv4 单栈。
 */
export async function supportsIpv6(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(0, '::');
  });
}

/**
 * 构造 WS 监听地址：IPv4 + IPv6 双栈同端口（IPv6 全球单播可达，天然免 NAT 穿透）。
 * port 为 0 时两栈都由 OS 分配临时端口。
 */
export function buildWsListenAddrs(port: number, ipv6Enabled: boolean): string[] {
  const addresses = [`/ip4/0.0.0.0/tcp/${port}/ws`];
  if (ipv6Enabled) {
    addresses.push(`/ip6/::/tcp/${port}/ws`);
  }
  return addresses;
}
