import { buildUserAgent, DEFAULT_QUOTA_PER_HOUR, SingleKeyStore, systemClock, type Clock, type KeyStore } from '@ieisi/rir-mcp-core';
import { localhostAllowedHostnames, localhostAllowedOrigins } from '@modelcontextprotocol/server';
import { ConfigError } from './errors';
import { FileKeyStore, type KeysFileIo } from './keys-file';

export { ConfigError } from './errors';

type Env = Readonly<Record<string, string | undefined>>;

export interface NodeConfig {
  readonly operator: string;
  readonly userAgent: string;
}

export function loadConfig(env: Env): NodeConfig {
  const operator = env.RIR_MCP_OPERATOR?.trim() ?? '';
  if (operator === '') {
    throw new ConfigError(
      'RIR_MCP_OPERATOR is required: a contact email or URL for whoever runs this server. ' +
        'It is sent in the User-Agent so the RIRs can reach you.',
    );
  }
  try {
    return { operator, userAgent: buildUserAgent(operator) };
  } catch (err) {
    throw new ConfigError(`RIR_MCP_OPERATOR is invalid: ${(err as Error).message}`);
  }
}

export interface HttpConfig extends NodeConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: string[];
  readonly allowedOrigins: string[];
  readonly keyStore: KeyStore;
  readonly authMode: 'per-user' | 'single';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function list(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return items && items.length > 0 ? items : undefined;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function loadHttpConfig(env: Env, io: KeysFileIo, clock: Clock = systemClock, onKeysReloadError?: (message: string) => void): HttpConfig {
  const base = loadConfig(env);
  const host = env.RIR_MCP_HTTP_HOST?.trim() || '127.0.0.1';
  // 4608: IANA-unassigned (4607-4620), clear of common dev ports (wrangler dev uses 8787), and APNIC's ASN.
  const port = integer(env, 'RIR_MCP_HTTP_PORT', 4608, 0, 65_535);
  const quota = integer(env, 'RIR_MCP_QUOTA_PER_HOUR', DEFAULT_QUOTA_PER_HOUR, 1, 1_000_000);
  const allowedHosts = list(env.RIR_MCP_ALLOWED_HOSTS) ?? (LOOPBACK.has(host) ? localhostAllowedHostnames() : undefined);
  if (!allowedHosts) {
    throw new ConfigError(`RIR_MCP_ALLOWED_HOSTS is required when binding ${host}: list the hostnames clients use to reach this server (DNS-rebinding protection).`);
  }
  const allowedOrigins = list(env.RIR_MCP_ALLOWED_ORIGINS) ?? localhostAllowedOrigins();
  const keysFile = env.RIR_MCP_KEYS_FILE?.trim();
  const apiKey = env.RIR_MCP_API_KEY?.trim();
  let keyStore: KeyStore;
  let authMode: HttpConfig['authMode'];
  if (keysFile) {
    keyStore = new FileKeyStore(keysFile, io, clock, { onReloadError: onKeysReloadError });
    authMode = 'per-user';
  } else if (apiKey) {
    try {
      keyStore = new SingleKeyStore(apiKey, quota);
    } catch (err) {
      throw new ConfigError(`RIR_MCP_API_KEY is invalid: ${(err as Error).message}`);
    }
    authMode = 'single';
  } else {
    throw new ConfigError('HTTP needs RIR_MCP_KEYS_FILE or RIR_MCP_API_KEY; refusing to start without authentication.');
  }
  return { ...base, host, port, allowedHosts, allowedOrigins, keyStore, authMode };
}
