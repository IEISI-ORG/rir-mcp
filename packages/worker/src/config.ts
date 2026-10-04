import { BARE_HOST, buildUserAgent, SingleKeyStore, type KeyStore } from '@ieisi/rir-mcp-core';
import { KvKeyStore } from './kv-keys';

/** `API_KEY` is a secret (`wrangler secret put API_KEY`), so `wrangler types` does not list it. */
export type WorkerEnv = Env & { readonly API_KEY?: string };

export interface WorkerConfig {
  readonly keyStore: KeyStore;
  readonly allowedHosts: string[];
  readonly allowedOrigins: string[];
}

/** The `error` names the setting only, never its value, so it is safe to log. */
export type ConfigResult = WorkerConfig | { readonly error: string };

function list(value: string | undefined): string[] | undefined {
  const items = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return items.every((h) => BARE_HOST.test(h)) ? items : undefined;
}

/** Fails closed: any missing or invalid setting is an error, and the Worker then answers 503 to everything. */
export function loadWorkerConfig(env: WorkerEnv): ConfigResult {
  try {
    // The DO builds its User-Agent from OPERATOR; an invalid value would make every request throw there.
    buildUserAgent(env.OPERATOR ?? '');
  } catch {
    return { error: 'OPERATOR' };
  }
  const allowedHosts = list(env.ALLOWED_HOSTS);
  if (!allowedHosts || allowedHosts.length === 0) return { error: 'ALLOWED_HOSTS' };
  const allowedOrigins = list(env.ALLOWED_ORIGINS);
  if (!allowedOrigins) return { error: 'ALLOWED_ORIGINS' };
  // Per-user keys only when the operator says so: the KV binding is always declared, possibly empty.
  if (env.KEYS_MODE === 'kv') {
    if (!env.API_KEYS) return { error: 'API_KEYS' };
    return { keyStore: new KvKeyStore(env.API_KEYS), allowedHosts, allowedOrigins };
  }
  if (env.KEYS_MODE !== undefined && env.KEYS_MODE !== '') return { error: 'KEYS_MODE' };
  if (!env.API_KEY) return { error: 'API_KEY' };
  try {
    return { keyStore: new SingleKeyStore(env.API_KEY), allowedHosts, allowedOrigins };
  } catch {
    return { error: 'API_KEY' };
  }
}
