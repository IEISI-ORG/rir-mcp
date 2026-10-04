import type { CacheEntry, CacheStore, ClientGate, ClientInfo, Clock, GateResult, RateLimiter } from '../ports';
import { fetchJson, type HttpDeps } from '../rdap/client';
import { RdapError } from '../rdap/errors';
import { RIR_LABEL, rirForHost, type Rir } from '../rdap/rirs';
import type { ErrorCode } from './answer';

export const TTL_S = {
  current: 3600,
  currentStale: 86_400,
  notFound: 900,
  history: 7 * 86_400,
  historyStale: 30 * 86_400,
} as const;

export const WEIGHT = { current: 1, history: 5 } as const;

/** `rir` and `url` are those of the registry that actually served the record (may differ after a redirect). */
export type Stored<T> = { readonly found: true; readonly value: T; readonly rir: Rir; readonly url: string } | { readonly found: false };

export type FetchOutcome<T> =
  | {
    readonly ok: true;
    readonly value: T;
    readonly cache: 'miss' | 'hit' | 'stale';
    readonly fetchedAt: number;
    readonly rir: Rir;
    readonly url: string;
  }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly retryAfterS?: number };

export interface FetchRequest<T> {
  readonly key: string;
  readonly rir: Rir;
  readonly url: string;
  readonly weight: number;
  readonly freshS: number;
  readonly staleS: number;
  readonly maxBytes: number;
  /** Must drop personal data: its output is what gets cached. */
  readonly reduce: (raw: unknown, rir: Rir) => T;
  readonly force?: boolean;
  /** Set on client-scoped services: upstream calls are charged to this client's quota. */
  readonly scope?: ClientScope;
  /** Shared by the fetches of one logical lookup (e.g. a reverse-DNS zone walk) so the quota is charged once (Q5). */
  readonly ticket?: QuotaTicket;
}

export interface QuotaTicket {
  charged: boolean;
}

/** The authenticated client a service view acts for (HTTP), and the gate that limits it. */
export interface ClientScope {
  readonly client: ClientInfo;
  readonly gate: ClientGate;
}

export function gateDenied(g: Exclude<GateResult, { ok: true }>): Extract<FetchOutcome<never>, { ok: false }> {
  switch (g.reason) {
    case 'quota':
      return { ok: false, code: 'quota_exceeded', message: `Hourly lookup quota for this API key is used up; cached answers still work. Retry in ${g.retryAfterS}s.`, retryAfterS: g.retryAfterS };
    case 'rate':
      return { ok: false, code: 'rate_limited', message: `Too many calls for this API key; retry in ${g.retryAfterS}s.`, retryAfterS: g.retryAfterS };
    case 'suspended':
      return { ok: false, code: 'suspended', message: 'This API key is suspended for unusual query volume; contact the operator.', retryAfterS: g.retryAfterS };
  }
}

export interface FetcherDeps {
  readonly http: HttpDeps;
  readonly cache: CacheStore;
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly rdapHosts: () => Promise<ReadonlySet<string>>;
}

const notFound = (rir: Rir): FetchOutcome<never> => ({
  ok: false,
  code: 'not_found',
  message: `Not registered in ${RIR_LABEL[rir]}; it may be unallocated or held elsewhere.`,
});

function fromEntry<T>(entry: CacheEntry<Stored<T>>, cache: 'hit' | 'stale', rir: Rir): FetchOutcome<T> {
  const v = entry.value;
  return v.found ? { ok: true, value: v.value, cache, fetchedAt: entry.fetchedAt, rir: v.rir, url: v.url } : notFound(rir);
}

/** Thrown from the redirect hook when the redirect target's local bucket is empty. */
class LocalRateLimit extends Error {
  readonly retryAfterS: number;
  readonly rir: Rir;
  constructor(rir: Rir, retryAfterS: number) {
    super('local rate limit');
    this.rir = rir;
    this.retryAfterS = retryAfterS;
  }
}

const rateLimited = (rir: Rir, retryAfterS: number): FetchOutcome<never> => ({
  ok: false,
  code: 'rate_limited',
  message: `Rate limit for ${RIR_LABEL[rir]} lookups reached; retry in ${retryAfterS}s.`,
  retryAfterS,
});

/** In-flight result for a request its originator's client gate refused: per-client, never shared. */
const DENIED = Symbol('denied');

/** cache -> coalesce -> client gate -> limiter (refund on refusal) -> fetch -> reduce -> cache, with stale-on-error (spec §5). */
export class CachedFetcher {
  private readonly deps: FetcherDeps;
  private readonly inflight = new Map<string, Promise<FetchOutcome<unknown> | typeof DENIED>>();

  constructor(deps: FetcherDeps) {
    this.deps = deps;
  }

  peek<T>(key: string): Promise<CacheEntry<Stored<T>> | null> {
    return this.deps.cache.get<Stored<T>>(key);
  }

  async get<T>(req: FetchRequest<T>): Promise<FetchOutcome<T>> {
    const entry = await this.deps.cache.get<Stored<T>>(req.key);
    if (entry && !req.force && this.deps.clock.now() < entry.freshUntil) return fromEntry(entry, 'hit', req.rir);
    const running = this.inflight.get(req.key);
    if (running) {
      const out = await running;
      // The originator was refused by its own client gate; that refusal is not ours, so try on our own account.
      return out === DENIED ? this.get(req) : (out as FetchOutcome<T>);
    }
    let denial: Exclude<GateResult, { ok: true }> | undefined;
    const p = (async (): Promise<FetchOutcome<T> | typeof DENIED> => {
      // Charge the client first so an over-quota client cannot spend shared RIR tokens...
      let charged = false;
      if (req.scope && !req.ticket?.charged) {
        const g = await req.scope.gate.charge(req.scope.client, req.weight);
        if (!g.ok) {
          denial = g;
          return DENIED;
        }
        charged = true;
        if (req.ticket) req.ticket.charged = true;
      }
      const permit = await this.deps.limiter.acquire(req.rir, req.weight);
      if (!permit.ok) {
        // ...and give the charge back when the shared limiter refuses: no upstream call was made.
        if (charged && req.scope) {
          await req.scope.gate.refund(req.scope.client, req.weight);
          if (req.ticket) req.ticket.charged = false;
        }
        return entry ? fromEntry(entry, 'stale', req.rir) : rateLimited(req.rir, permit.retryAfterS);
      }
      return this.refresh(req, entry);
    })().finally(() => this.inflight.delete(req.key));
    this.inflight.set(req.key, p);
    const out = await p;
    if (out !== DENIED) return out;
    return entry ? fromEntry(entry, 'stale', req.rir) : gateDenied(denial as Exclude<GateResult, { ok: true }>);
  }

  private async refresh<T>(req: FetchRequest<T>, entry: CacheEntry<Stored<T>> | null): Promise<FetchOutcome<T>> {
    const fallback = entry ? fromEntry(entry, 'stale', req.rir) : null;
    let actual: Rir = req.rir;
    try {
      const hosts = await this.deps.rdapHosts();
      const { body, finalUrl } = await fetchJson(
        req.url,
        {
          maxBytes: req.maxBytes,
          allowRedirectTo: (h) => hosts.has(h),
          onRedirect: async (host) => {
            const target = rirForHost(host);
            if (!target) return;
            // Every request to a registry takes a token, including a redirect within the same RIR.
            const p = await this.deps.limiter.acquire(target, req.weight);
            if (!p.ok) throw new LocalRateLimit(target, p.retryAfterS);
            actual = target;
          },
        },
        this.deps.http,
      );
      actual = rirForHost(new URL(finalUrl).hostname) ?? req.rir;
      const value = req.reduce(body, actual);
      await this.store(req.key, { found: true, value, rir: actual, url: finalUrl }, req.freshS, req.staleS);
      return { ok: true, value, cache: 'miss', fetchedAt: this.deps.clock.now(), rir: actual, url: finalUrl };
    } catch (err) {
      if (err instanceof LocalRateLimit) return fallback ?? rateLimited(err.rir, err.retryAfterS);
      if (!(err instanceof RdapError)) throw err;
      if (err.code === 'not_found') {
        await this.store(req.key, { found: false }, TTL_S.notFound, TTL_S.notFound);
        return notFound(req.rir);
      }
      if (err.code === 'too_large') return { ok: false, code: 'too_large', message: 'The registry response was too large to use.' };
      await this.deps.limiter.penalise(actual, err.retryAfterS);
      return fallback ?? {
        ok: false,
        code: 'upstream',
        message: `${RIR_LABEL[actual]} RDAP is unavailable right now (${err.code}); try again later.`,
        retryAfterS: err.retryAfterS,
      };
    }
  }

  private async store<T>(key: string, value: Stored<T>, freshS: number, staleS: number): Promise<void> {
    const t = this.deps.clock.now();
    await this.deps.cache.put<Stored<T>>(key, { value, fetchedAt: t, freshUntil: t + freshS * 1000, staleUntil: t + staleS * 1000 });
  }
}
