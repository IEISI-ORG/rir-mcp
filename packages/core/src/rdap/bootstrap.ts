import { parseIpOrCidr, prefixContains, type IpPrefix } from '../input/ip';
import type { CacheStore, Clock } from '../ports';
import { fetchJson, type HttpDeps } from './client';
import { RdapError } from './errors';
import { rirForHost, type Rir } from './rirs';

export const IANA_BOOTSTRAP_BASE = 'https://data.iana.org/rdap/';
const FILES = ['ipv4', 'ipv6', 'asn'] as const;
const CACHE_KEY = 'iana:bootstrap:v1';
const FRESH_MS = 24 * 3_600_000;
const STALE_MS = 7 * 24 * 3_600_000;
/** After a failed refresh with stale data in hand, wait this long before trying IANA again. */
const RETRY_MS = 5 * 60_000;
/** Re-read the cache row at least this often, which also keeps it from sinking to the bottom of the LRU. */
const MEMO_MS = 3_600_000;
/** With no bootstrap data at all, a failed fetch is remembered this long: lookups fail fast instead of refetching. */
const COLD_RETRY_MS = 30_000;

type Service = [string[], string[]];
interface RawFile { readonly services: readonly Service[] }
type RawBootstrap = Readonly<Record<(typeof FILES)[number], RawFile>>;

export interface Route {
  readonly rir: Rir;
  readonly baseUrl: string;
}

interface Index {
  readonly ip: Array<{ prefix: IpPrefix; route: Route }>;
  readonly asn: Array<{ start: number; end: number; route: Route }>;
  readonly bases: Map<Rir, string>;
  readonly hosts: Set<string>;
}

/** Routes queries to the authoritative RIR using the IANA RDAP bootstrap files (RFC 9224). */
export class Bootstrap {
  private readonly http: HttpDeps;
  private readonly cache: CacheStore;
  private readonly clock: Clock;
  /** The parsed index and how long it may be used without consulting the cache (fresh, or a retry back-off). */
  private parsed: { fetchedAt: number; index: Index; validUntil: number; staleUntil: number } | null = null;
  private inflight: Promise<RawBootstrap> | null = null;
  private coldFailure: { until: number; error: RdapError } | null = null;

  constructor(deps: { http: HttpDeps; cache: CacheStore; clock: Clock }) {
    this.http = deps.http;
    this.cache = deps.cache;
    this.clock = deps.clock;
  }

  async routeIp(p: IpPrefix): Promise<Route | null> {
    const { ip } = await this.index();
    let best: { prefix: IpPrefix; route: Route } | null = null;
    for (const e of ip) {
      if (prefixContains(e.prefix, p) && (!best || e.prefix.length > best.prefix.length)) best = e;
    }
    return best ? best.route : null;
  }

  async routeAsn(n: number): Promise<Route | null> {
    const { asn } = await this.index();
    return asn.find((e) => n >= e.start && n <= e.end)?.route ?? null;
  }

  async baseUrl(rir: Rir): Promise<string> {
    const base = (await this.index()).bases.get(rir);
    if (!base) throw new RdapError('upstream', `The IANA bootstrap lists no RDAP service for ${rir}`);
    return base;
  }

  async rdapHosts(): Promise<ReadonlySet<string>> {
    return (await this.index()).hosts;
  }

  private async index(): Promise<Index> {
    // Every lookup routes through here 2–3 times: skip the cache read (in a Durable Object, a SQL read, a parse
    // of the whole bootstrap and a row write) while the parsed index is still valid.
    // Capped at MEMO_MS: reading the row hourly keeps a busy cache from evicting it, which would lose the stale fallback.
    if (this.parsed && this.clock.now() < this.parsed.validUntil) return this.parsed.index;
    const entry = await this.cache.get<RawBootstrap>(CACHE_KEY);
    const now = this.clock.now();
    if (!entry && !this.parsed && this.coldFailure && now < this.coldFailure.until) throw this.coldFailure.error;
    if (entry && now < entry.freshUntil) {
      return this.parse(entry.value, entry.fetchedAt, Math.min(entry.freshUntil, now + MEMO_MS), entry.staleUntil);
    }
    try {
      const raw = await this.fetchAll();
      const t = this.clock.now();
      const index = this.parse(raw, t, t + MEMO_MS, t + STALE_MS);
      if (index.ip.length === 0 && index.asn.length === 0) {
        this.parsed = null; // never reuse an empty index
        throw new RdapError('bad_response', 'IANA bootstrap response has no valid services');
      }
      await this.cache.put(CACHE_KEY, { value: raw, fetchedAt: t, freshUntil: t + FRESH_MS, staleUntil: t + STALE_MS });
      return index;
    } catch (err) {
      // Serve stale data and back off, rather than refetching all three files on every lookup during an outage;
      // never past the data's stale lifetime. If the cache lost the row, the parsed copy in memory still counts.
      const t = this.clock.now();
      // If IANA said how long to wait (Retry-After on 429/503), wait at least that long, up to an hour.
      const asked = err instanceof RdapError && err.retryAfterS ? Math.min(err.retryAfterS * 1000, MEMO_MS) : 0;
      const retryAt = t + Math.max(RETRY_MS, asked);
      if (entry) return this.parse(entry.value, entry.fetchedAt, Math.min(retryAt, entry.staleUntil), entry.staleUntil);
      if (this.parsed && t < this.parsed.staleUntil) {
        this.parsed.validUntil = Math.min(retryAt, this.parsed.staleUntil);
        return this.parsed.index;
      }
      // Nothing usable left (no entry, and the in-memory index is past its stale lifetime): forget it, so the cold
      // back-off below applies instead of refetching on every lookup.
      this.parsed = null;
      if (err instanceof RdapError) {
        const error = new RdapError('upstream', `IANA RDAP bootstrap unavailable (${err.code})`);
        this.coldFailure = { until: t + Math.max(COLD_RETRY_MS, asked), error };
        throw error;
      }
      throw err;
    }
  }

  private fetchAll(): Promise<RawBootstrap> {
    this.inflight ??= (async () => {
      const [ipv4, ipv6, asn] = await Promise.all(
        FILES.map((f) => fetchJson(`${IANA_BOOTSTRAP_BASE}${f}.json`, { maxBytes: 1_000_000 }, this.http).then((r) => r.body)),
      );
      return { ipv4: asRawFile(ipv4), ipv6: asRawFile(ipv6), asn: asRawFile(asn) };
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private parse(raw: RawBootstrap, fetchedAt: number, validUntil: number, staleUntil: number): Index {
    if (this.parsed?.fetchedAt === fetchedAt) {
      this.parsed.validUntil = validUntil;
      this.parsed.staleUntil = staleUntil;
      return this.parsed.index;
    }
    const index: Index = { ip: [], asn: [], bases: new Map(), hosts: new Set() };
    const routeOf = (urls: unknown): Route | null => {
      if (!Array.isArray(urls)) return null;
      for (const url of urls) {
        if (typeof url !== 'string') continue;
        if (!url.startsWith('https://')) continue;
        try {
          const u = new URL(url);
          // Same shape rule as redirects: default port, no userinfo, query or fragment.
          if (u.port !== '' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') continue;
          const host = u.hostname;
          const rir = rirForHost(host);
          if (!rir) continue;
          const baseUrl = url.endsWith('/') ? url : `${url}/`;
          index.bases.set(rir, baseUrl);
          index.hosts.add(host);
          return { rir, baseUrl };
        } catch {
          // Skip URLs that fail to parse.
        }
      }
      return null;
    };
    for (const file of [raw.ipv4, raw.ipv6]) {
      for (const entry of file.services) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [ranges, urls] = entry;
        if (!Array.isArray(ranges)) continue;
        const route = routeOf(urls);
        if (!route) continue;
        for (const r of ranges) {
          if (typeof r !== 'string') continue;
          try {
            index.ip.push({ prefix: parseIpOrCidr(r), route });
          } catch {
            // Skip a malformed IANA entry rather than failing every lookup.
          }
        }
      }
    }
    for (const entry of raw.asn.services) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [ranges, urls] = entry;
      if (!Array.isArray(ranges)) continue;
      const route = routeOf(urls);
      if (!route) continue;
      for (const r of ranges) {
        if (typeof r !== 'string') continue;
        const [a, b] = r.split('-');
        const start = Number(a);
        const end = Number(b ?? a);
        if (Number.isInteger(start) && Number.isInteger(end)) index.asn.push({ start, end, route });
      }
    }
    this.parsed = { fetchedAt, index, validUntil, staleUntil };
    return index;
  }
}

function asRawFile(v: unknown): RawFile {
  const services = (v as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) throw new RdapError('bad_response', 'IANA bootstrap file has no services array');
  return { services: services as Service[] };
}
