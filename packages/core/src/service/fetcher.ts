import type { CacheEntry, CacheStore, Clock, RateLimiter } from '../ports';
import { fetchJson, type HttpDeps } from '../rdap/client';
import { RdapError } from '../rdap/errors';
import { RIR_LABEL, type Rir } from '../rdap/rirs';
import type { ErrorCode } from './answer';

export const TTL_S = {
  current: 3600,
  currentStale: 86_400,
  notFound: 900,
  history: 7 * 86_400,
  historyStale: 30 * 86_400,
} as const;

export const WEIGHT = { current: 1, history: 5 } as const;

export type Stored<T> = { readonly found: true; readonly value: T } | { readonly found: false };

export type FetchOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly cache: 'miss' | 'hit' | 'stale'; readonly fetchedAt: number }
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
  readonly reduce: (raw: unknown) => T;
  readonly force?: boolean;
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
  return entry.value.found ? { ok: true, value: entry.value.value, cache, fetchedAt: entry.fetchedAt } : notFound(rir);
}

/** cache -> coalesce -> limiter -> fetch -> reduce -> cache, with stale-on-error (spec §5). */
export class CachedFetcher {
  private readonly deps: FetcherDeps;
  private readonly inflight = new Map<string, Promise<FetchOutcome<unknown>>>();

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
    if (running) return running as Promise<FetchOutcome<T>>;
    const p = this.refresh(req, entry).finally(() => this.inflight.delete(req.key));
    this.inflight.set(req.key, p);
    return p;
  }

  private async refresh<T>(req: FetchRequest<T>, entry: CacheEntry<Stored<T>> | null): Promise<FetchOutcome<T>> {
    const fallback = entry ? fromEntry(entry, 'stale', req.rir) : null;
    const permit = await this.deps.limiter.acquire(req.rir, req.weight);
    if (!permit.ok) {
      return fallback ?? {
        ok: false,
        code: 'rate_limited',
        message: `Rate limit for ${RIR_LABEL[req.rir]} lookups reached; retry in ${permit.retryAfterS}s.`,
        retryAfterS: permit.retryAfterS,
      };
    }
    try {
      const hosts = await this.deps.rdapHosts();
      const raw = await fetchJson(req.url, { maxBytes: req.maxBytes, allowRedirectTo: (h) => hosts.has(h) }, this.deps.http);
      const value = req.reduce(raw);
      await this.store(req.key, { found: true, value }, req.freshS, req.staleS);
      return { ok: true, value, cache: 'miss', fetchedAt: this.deps.clock.now() };
    } catch (err) {
      if (!(err instanceof RdapError)) throw err;
      if (err.code === 'not_found') {
        await this.store(req.key, { found: false }, TTL_S.notFound, TTL_S.notFound);
        return notFound(req.rir);
      }
      if (err.code === 'too_large') return { ok: false, code: 'too_large', message: 'The registry response was too large to process.' };
      await this.deps.limiter.penalise(req.rir);
      return fallback ?? {
        ok: false,
        code: 'upstream',
        message: `${RIR_LABEL[req.rir]} RDAP is unavailable right now (${err.code}); try again later.`,
        retryAfterS: err.retryAfterS,
      };
    }
  }

  private async store<T>(key: string, value: Stored<T>, freshS: number, staleS: number): Promise<void> {
    const t = this.deps.clock.now();
    await this.deps.cache.put<Stored<T>>(key, { value, fetchedAt: t, freshUntil: t + freshS * 1000, staleUntil: t + staleS * 1000 });
  }
}
