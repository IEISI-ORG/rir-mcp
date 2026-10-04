import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import {
  clearExpiredUnits, DEFAULT_LIMITS, MemoryCache, MemoryClientGate, MemoryRateLimiter, RirService, systemClock, type ClientState,
} from '@ieisi/rir-mcp-core';
import { ConfigError, loadHttpConfig, type HttpConfig } from './config';
import { createHttpApp } from './http-app';
import { startHttp } from './http-bridge';

// Node's 250 ms Happy Eyeballs default times out on high-latency RIRs (e.g. LACNIC, AFRINIC from Australia).
setDefaultAutoSelectFamilyAttemptTimeout(2000);

// One JSON line per event on stderr. Never pass header values, keys, query values or error messages here.
const log = (line: Record<string, unknown>): void => console.error(JSON.stringify(line));
const now = (): string => new Date().toISOString();
// Error messages and stacks may contain query values: log the type only.
const onError = (err: unknown): void => log({ t: now(), error: err instanceof Error ? err.name : typeof err });

let config: HttpConfig;
try {
  config = loadHttpConfig(process.env, { read: (p) => readFileSync(p, 'utf8') }, systemClock, (message) => log({ t: now(), alert: 'keys_file', message }));
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`rir-mcp: ${err.message}`);
  process.exit(1);
}

const service = new RirService({
  fetch: (url, init) => fetch(url, init),
  cache: new MemoryCache(systemClock),
  limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock),
  clock: systemClock,
  userAgent: config.userAgent,
});

// Scan digests of a client that stops querying are cleared hourly, not kept until its next request or a restart.
const gateState = new Map<string, ClientState>();
setInterval(() => clearExpiredUnits(gateState, systemClock.now()), 3_600_000).unref();

const app = createHttpApp({
  service,
  gate: new MemoryClientGate(systemClock, { state: gateState, onSuspend: (id) => log({ t: now(), alert: 'client_suspended', client: id }) }),
  keyStore: config.keyStore,
  allowedHosts: config.allowedHosts,
  allowedOrigins: config.allowedOrigins,
  log,
  onError,
});

const server = await startHttp(config, app, onError);
const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
console.error(`rir-mcp: listening on http://${shown}:${server.port}/mcp (auth: ${config.authMode})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
