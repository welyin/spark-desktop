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

export async function isTcpPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

export async function pickListenPort(preferredPort: number, scanRange = DEFAULT_PORT_SCAN_RANGE): Promise<number> {
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
    if (await isTcpPortAvailable(port)) {
      return port;
    }
  }

  // As a last resort, allow OS to allocate an ephemeral port.
  return 0;
}
