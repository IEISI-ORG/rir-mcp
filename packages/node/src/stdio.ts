import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createServer, DEFAULT_LIMITS, MemoryCache, MemoryRateLimiter, RirService, systemClock } from '@ieisi/rir-mcp-core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config';

// Node's 250 ms Happy Eyeballs default times out on high-latency RIRs (e.g. LACNIC, AFRINIC from Australia).
setDefaultAutoSelectFamilyAttemptTimeout(2000);

let userAgent: string;
try {
  userAgent = loadConfig(process.env).userAgent;
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`rir-mcp: ${err.message}`);
  process.exit(1);
}

// Log only the error type: messages and stacks may contain query values, which must never be logged.
const reportError = (err: unknown): void => console.error(`rir-mcp: internal error (${err instanceof Error ? err.name : typeof err})`);

const service = new RirService({
  fetch: (url, init) => fetch(url, init),
  cache: new MemoryCache(systemClock),
  limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock),
  clock: systemClock,
  userAgent,
  onStoreError: reportError,
});

serveStdio(() => createServer(service, { onError: reportError }));
// stdout carries the protocol; diagnostics go to stderr only.
console.error('rir-mcp: listening on stdio');
