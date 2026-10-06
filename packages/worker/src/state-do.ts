import {
  buildUserAgent, DEFAULT_LIMITS, mcpHandler, MemoryClientGate, MemoryRateLimiter, RirService, systemClock,
  type BucketState, type ClientInfo, type ClientState, type FetchLike, type McpHandler,
} from '@ieisi/rir-mcp-core';
import { DurableObject } from 'cloudflare:workers';
import { createTables, purgeExpiredScanUnits, SqlCache, SqlStateMap } from './sql-store';

// One JSON line per event, read by Workers observability. Never pass header values, keys, query values or error messages.
const log = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));
// Error messages and stacks may contain query values: log the type only.
const onError = (err: unknown): void => log({ t: new Date().toISOString(), error: err instanceof Error ? err.name : typeof err });

const HOUR_MS = 3_600_000;
const MIN_ALARM_GAP_MS = 5 * 60_000;

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The single stateful instance (spec §6, Q9): runs the MCP handler for clients the edge Worker has already admitted.
 * Cache, rate limits, quotas and scan state live in this object's SQLite, so they survive eviction.
 * Construction is synchronous SQL only, so it needs no blockConcurrencyWhile.
 */
export class StateDO extends DurableObject<Env> {
  /** Outbound fetch for RDAP and IANA. Tests replace it: the Vitest plugin has no outbound fetch mocking. */
  upstream: FetchLike = (url, init) => fetch(url, init);
  private readonly handler: McpHandler;
  private readonly cache: SqlCache;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    createTables(sql);
    // The scan detector stores salted digests; the salt must outlive them, so it is persisted with them.
    const meta = new SqlStateMap<string>(sql, 'meta');
    let salt = meta.get('salt');
    if (salt === undefined) {
      salt = randomSalt();
      meta.set('salt', salt);
    }
    this.cache = new SqlCache(sql, systemClock);
    const service = new RirService({
      fetch: (url, init) => this.upstream(url, init),
      cache: this.cache,
      limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock, new SqlStateMap<BucketState>(sql, 'limiter')),
      clock: systemClock,
      // Read once: a changed OPERATOR is a new Worker version, and a Durable Object is reset when it moves to a new version.
      userAgent: buildUserAgent(env.OPERATOR),
    });
    const gate = new MemoryClientGate(systemClock, {
      state: new SqlStateMap<ClientState>(sql, 'gate'),
      salt,
      onSuspend: (id) => log({ t: new Date().toISOString(), alert: 'client_suspended', client: id }),
    });
    this.handler = mcpHandler({ service, gate, log, onError });
  }

  /** RPC from the edge Worker, only after `edgeGate` admitted the request: `client` is trusted here. */
  async serve(request: Request, client: ClientInfo): Promise<Response> {
    const res = await this.handler.fetch(request, client);
    // Make sure scan digests and expired cache rows get purged within the hour even if no further request arrives:
    // arm the alarm, or bring a later one forward. A storage error here must not lose an answer the client has
    // already been charged for; the next request re-arms.
    try {
      const due = Date.now() + HOUR_MS;
      const at = await this.ctx.storage.getAlarm();
      if (at === null || at > due) await this.ctx.storage.setAlarm(due);
    } catch (err) {
      onError(err);
    }
    return res;
  }

  /**
   * Purges scan digests of ended windows and expired cache rows, then re-arms for the next expiry while any remain:
   * no later than an hour (the documented retention), no sooner than 5 minutes (each run scans the cache table, so
   * not one run per expiry) (code review 2026-10-07 C1, I1).
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const times = [purgeExpiredScanUnits(this.ctx.storage.sql, now), this.cache.purgeExpired()]
      .filter((t): t is number => t !== null);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(Math.max(Math.min(...times), now + MIN_ALARM_GAP_MS), now + HOUR_MS));
  }
}
