import { parseIpOrCidr, prefixContains, type IpPrefix } from '../input/ip';
import type { CacheStore, Clock } from '../ports';
import { fetchJson, type HttpDeps } from './client';
import { RdapError } from './errors';
import { RIR_HOSTS, type Rir } from './rirs';

export const IANA_BOOTSTRAP_BASE = 'https://data.iana.org/rdap/';
const FILES = ['ipv4', 'ipv6', 'asn'] as const;
const CACHE_KEY = 'iana:bootstrap:v1';
const FRESH_MS = 24 * 3_600_000;
const STALE_MS = 7 * 24 * 3_600_000;

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
  private parsed: { fetchedAt: number; index: Index } | null = null;
  private inflight: Promise<RawBootstrap> | null = null;

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
    const entry = await this.cache.get<RawBootstrap>(CACHE_KEY);
    if (entry && this.clock.now() < entry.freshUntil) return this.parse(entry.value, entry.fetchedAt);
    try {
      const raw = await this.fetchAll();
      const t = this.clock.now();
      await this.cache.put(CACHE_KEY, { value: raw, fetchedAt: t, freshUntil: t + FRESH_MS, staleUntil: t + STALE_MS });
      return this.parse(raw, t);
    } catch (err) {
      if (entry) return this.parse(entry.value, entry.fetchedAt);
      if (err instanceof RdapError) throw new RdapError('upstream', `IANA RDAP bootstrap unavailable (${err.code})`);
      throw err;
    }
  }

  private fetchAll(): Promise<RawBootstrap> {
    this.inflight ??= (async () => {
      const [ipv4, ipv6, asn] = await Promise.all(
        FILES.map((f) => fetchJson(`${IANA_BOOTSTRAP_BASE}${f}.json`, { maxBytes: 1_000_000 }, this.http)),
      );
      return { ipv4: asRawFile(ipv4), ipv6: asRawFile(ipv6), asn: asRawFile(asn) };
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private parse(raw: RawBootstrap, fetchedAt: number): Index {
    if (this.parsed?.fetchedAt === fetchedAt) return this.parsed.index;
    const index: Index = { ip: [], asn: [], bases: new Map(), hosts: new Set() };
    const routeOf = (urls: readonly string[]): Route | null => {
      const https = urls.find((u) => u.startsWith('https://'));
      if (!https) return null;
      const host = new URL(https).hostname;
      const rir = RIR_HOSTS[host];
      if (!rir) return null;
      const baseUrl = https.endsWith('/') ? https : `${https}/`;
      index.bases.set(rir, baseUrl);
      index.hosts.add(host);
      return { rir, baseUrl };
    };
    for (const file of [raw.ipv4, raw.ipv6]) {
      for (const [ranges, urls] of file.services) {
        const route = routeOf(urls);
        if (!route) continue;
        for (const r of ranges) {
          try {
            index.ip.push({ prefix: parseIpOrCidr(r), route });
          } catch {
            // Skip a malformed IANA entry rather than failing every lookup.
          }
        }
      }
    }
    for (const [ranges, urls] of raw.asn.services) {
      const route = routeOf(urls);
      if (!route) continue;
      for (const r of ranges) {
        const [a, b] = r.split('-');
        const start = Number(a);
        const end = Number(b ?? a);
        if (Number.isInteger(start) && Number.isInteger(end)) index.asn.push({ start, end, route });
      }
    }
    this.parsed = { fetchedAt, index };
    return index;
  }
}

function asRawFile(v: unknown): RawFile {
  const services = (v as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) throw new RdapError('bad_response', 'IANA bootstrap file has no services array');
  return { services: services as Service[] };
}
