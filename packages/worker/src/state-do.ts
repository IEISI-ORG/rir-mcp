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
  private readonly sql: SqlStorage;
  private readonly salt: string;
  private handler: McpHandler;
  /** The OPERATOR the handler's User-Agent was built from. */
  private operator: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    createTables(this.sql);
    // The scan detector stores salted digests; the salt must outlive them, so it is persisted with them.
    const meta = new SqlStateMap<string>(this.sql, 'meta');
    let salt = meta.get('salt');
    if (salt === undefined) {
      salt = randomSalt();
      meta.set('salt', salt);
    }
    this.salt = salt;
    this.operator = env.OPERATOR;
    this.handler = this.build(env.OPERATOR);
  }

  /** All state that matters lives in SQLite, so a rebuilt handler carries on where the old one stopped. */
  private build(operator: string): McpHandler {
    const sql = this.sql;
    const service = new RirService({
      fetch: (url, init) => this.upstream(url, init),
      cache: new SqlCache(sql, systemClock),
      limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock, new SqlStateMap<BucketState>(sql, 'limiter')),
      clock: systemClock,
      userAgent: buildUserAgent(operator),
    });
    const gate = new MemoryClientGate(systemClock, {
      state: new SqlStateMap<ClientState>(sql, 'gate'),
      salt: this.salt,
      onSuspend: (id) => log({ t: new Date().toISOString(), alert: 'client_suspended', client: id }),
    });
    return mcpHandler({ service, gate, log, onError });
  }

  /** RPC from the edge Worker, only after `edgeGate` admitted the request: `client` is trusted here. */
  async serve(request: Request, client: ClientInfo): Promise<Response> {
    // Cloudflare documents a reset for code updates; a variable-only change may leave this object running, and the
    // registries must see the operator's current contact.
    if (this.env.OPERATOR !== this.operator) {
      this.handler = this.build(this.env.OPERATOR);
      this.operator = this.env.OPERATOR;
    }
    const res = await this.handler.fetch(request, client);
    // Make sure scan digests get purged even if no further request ever arrives. A storage error here must not
    // lose an answer the client has already been charged for; the next request re-arms.
    try {
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
    } catch (err) {
      onError(err);
    }
    return res;
  }

  /** Purges scan digests of ended windows; re-arms only while some remain. */
  override async alarm(): Promise<void> {
    const next = purgeExpiredScanUnits(this.ctx.storage.sql, Date.now());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
