import { parseAsn } from '../input/asn';
import { InputError } from '../input/errors';
import { inferRirFromHandle, parseHandle } from '../input/handle';
import { formatPrefix, parseIpOrCidr } from '../input/ip';
import { reverseZones } from '../input/reverse-zone';
import type { CacheStore, ClientGate, Clock, FetchLike, RateLimiter } from '../ports';
import { Bootstrap } from '../rdap/bootstrap';
import { MAX_BYTES, type HttpDeps } from '../rdap/client';
import { RdapError } from '../rdap/errors';
import { RIR_LABEL, type Rir } from '../rdap/rirs';
import { reduceAutnum } from '../reduce/autnum';
import { reduceDomain } from '../reduce/domain';
import { reduceEntity } from '../reduce/entity';
import { reduceHistory, type HistoryRecord } from '../reduce/history';
import { reduceNetwork } from '../reduce/network';
import type { AutnumRecord, DomainRecord, EntityRecord, NetworkRecord } from '../reduce/types';
import { expectClass } from '../reduce/util';
import { specialUseForAsn, specialUseForIp } from '../special-use';
import type { Answer } from './answer';
import { CachedFetcher, gateDenied, TTL_S, WEIGHT, type ClientScope, type FetchOutcome, type FetchRequest, type QuotaTicket } from './fetcher';
import { scanUnitForAsn, scanUnitForHandle, scanUnitForIp } from './scan-unit';

export type { ClientScope } from './fetcher';

export interface ServiceDeps {
  readonly fetch: FetchLike;
  readonly cache: CacheStore;
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly userAgent: string;
  readonly timeoutMs?: number;
  /** Told when the cache cannot store an answer; the answer is still returned. Report the error by type only. */
  readonly onStoreError?: (err: unknown) => void;
}

export type HistoryType = 'ip' | 'asn' | 'entity' | 'reverse_dns';

export interface HistoryRequest {
  readonly resource: string;
  readonly type?: HistoryType;
  readonly rir?: Rir;
}

type NoRecord = Exclude<Answer<never>, { kind: 'record' }>;
interface HistoryTarget {
  readonly rir: Rir;
  readonly path: string;
  readonly query: string;
  readonly loadCurrent: () => Promise<Answer<{ readonly changed?: string }>>;
  /** Companion answer already fetched while resolving the target (entity, reverse DNS). */
  readonly preloaded?: Answer<{ readonly changed?: string }>;
}

const CURRENT = { weight: WEIGHT.current, freshS: TTL_S.current, staleS: TTL_S.currentStale, maxBytes: MAX_BYTES.current } as const;

export function inferHistoryType(resource: string): HistoryType {
  const s = resource.trim();
  try {
    parseIpOrCidr(s);
    return 'ip';
  } catch {
    // not an IP address
  }
  return /^(AS\s*)?\d+(\.\d+)?$/i.test(s) ? 'asn' : 'entity';
}

const notDelegated = (query: string): NoRecord => ({
  kind: 'error',
  code: 'not_delegated',
  message: `${query} is not delegated to a single RIR in the IANA bootstrap registry.`,
});

async function guard<T>(fn: () => Promise<Answer<T>>): Promise<Answer<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InputError) return { kind: 'error', code: 'invalid_input', message: `${err.message}. ${err.hint}` };
    if (err instanceof RdapError) return { kind: 'error', code: 'upstream', message: err.message };
    throw err;
  }
}

export class RirService {
  private readonly clock: Clock;
  private readonly bootstrap: Bootstrap;
  private readonly fetcher: CachedFetcher;
  private readonly deps: ServiceDeps;
  private readonly scope?: ClientScope;

  constructor(deps: ServiceDeps, shared?: { readonly bootstrap: Bootstrap; readonly fetcher: CachedFetcher }, scope?: ClientScope) {
    this.deps = deps;
    this.clock = deps.clock;
    this.scope = scope;
    if (shared) {
      this.bootstrap = shared.bootstrap;
      this.fetcher = shared.fetcher;
      return;
    }
    const http: HttpDeps = { fetch: deps.fetch, userAgent: deps.userAgent, timeoutMs: deps.timeoutMs };
    const bootstrap = new Bootstrap({ http, cache: deps.cache, clock: deps.clock });
    this.bootstrap = bootstrap;
    this.fetcher = new CachedFetcher({
      http, cache: deps.cache, limiter: deps.limiter, clock: deps.clock,
      rdapHosts: () => bootstrap.rdapHosts(), onStoreError: deps.onStoreError,
    });
  }

  /** A view for one authenticated client: same cache, bootstrap and in-flight coalescing, plus quota and scan checks. */
  forClient(scope: ClientScope): RirService {
    return new RirService(this.deps, { bootstrap: this.bootstrap, fetcher: this.fetcher }, scope);
  }

  ip(input: string): Promise<Answer<NetworkRecord>> {
    return guard(async () => {
      const p = parseIpOrCidr(input);
      const query = formatPrefix(p);
      const special = specialUseForIp(p);
      if (special) return { kind: 'special', query, special };
      const denied = await this.admit(scanUnitForIp(p));
      if (denied) return denied;
      const route = await this.bootstrap.routeIp(p);
      if (!route) return notDelegated(query);
      const url = `${route.baseUrl}ip/${query}`;
      const out = await this.get({
        ...CURRENT, key: `ip:${query}`, rir: route.rir, url,
        reduce: (raw, rir) => reduceNetwork(expectClass(raw, 'ip network'), { rir }),
      });
      return this.toAnswer(out);
    });
  }

  asn(input: string | number): Promise<Answer<AutnumRecord>> {
    return guard(async () => {
      const n = parseAsn(input);
      const query = `AS${n}`;
      const special = specialUseForAsn(n);
      if (special) return { kind: 'special', query, special };
      const denied = await this.admit(scanUnitForAsn(n));
      if (denied) return denied;
      const route = await this.bootstrap.routeAsn(n);
      if (!route) return notDelegated(query);
      const url = `${route.baseUrl}autnum/${n}`;
      const out = await this.get({
        ...CURRENT, key: `asn:${n}`, rir: route.rir, url,
        reduce: (raw, rir) => reduceAutnum(expectClass(raw, 'autnum'), { rir }),
      });
      return this.toAnswer(out);
    });
  }

  entity(handleInput: string, rirInput?: Rir): Promise<Answer<EntityRecord>> {
    return guard(async () => {
      const handle = parseHandle(handleInput);
      const rir = rirInput ?? inferRirFromHandle(handle);
      if (!rir) {
        return { kind: 'error', code: 'invalid_input', message: `Cannot tell which RIR holds ${handle}; pass rir as one of apnic, arin, ripe, lacnic, afrinic.` };
      }
      const denied = await this.admit(scanUnitForHandle(rir, handle));
      if (denied) return denied;
      const url = `${await this.bootstrap.baseUrl(rir)}entity/${encodeURIComponent(handle)}`;
      const out = await this.get({
        ...CURRENT, key: `entity:${rir}:${handle}`, rir, url,
        reduce: (raw, actual) => reduceEntity(expectClass(raw, 'entity'), { rir: actual }),
      });
      const answer = this.toAnswer(out);
      if (answer.kind !== 'record') return answer;
      if (answer.record.type === 'personal-entity') {
        return { kind: 'error', code: 'personal_record', message: `${handle} is a personal record; this service does not disclose personal contact data.` };
      }
      return { ...answer, record: answer.record };
    });
  }

  reverseDns(input: string): Promise<Answer<DomainRecord>> {
    return guard(async () => {
      const p = parseIpOrCidr(input);
      const query = formatPrefix(p);
      const special = specialUseForIp(p);
      if (special) return { kind: 'special', query, special };
      const denied = await this.admit(scanUnitForIp(p));
      if (denied) return denied;
      const zones = reverseZones(p);
      if (zones.length === 0) {
        return { kind: 'error', code: 'invalid_input', message: `${query} is too short for a reverse DNS zone; use an IPv4 /8 or longer, or an IPv6 /4 or longer.` };
      }
      const route = await this.bootstrap.routeIp(p);
      if (!route) return notDelegated(query);
      const ticket: QuotaTicket = { charged: false };
      for (const zone of zones) {
        const url = `${route.baseUrl}domain/${zone}`;
        const out = await this.get({
          ...CURRENT, key: `rdns:${zone}`, rir: route.rir, url,
          ticket, reduce: (raw, rir) => reduceDomain(expectClass(raw, 'domain'), { rir }),
        });
        if (out.ok || out.code !== 'not_found') return this.toAnswer(out);
      }
      return { kind: 'error', code: 'not_found', message: `No reverse DNS delegation is registered in ${RIR_LABEL[route.rir]} for ${query} (checked ${zones.join(', ')}).` };
    });
  }

  history(req: HistoryRequest): Promise<Answer<HistoryRecord>> {
    return guard(async () => {
      // The companion lookups run through a gate that counts the quota units they really cost (net of refunds), so
      // the history charge below is exact. Guessing from cache status let an exhausted key fetch history for free.
      const meter = { units: 0 };
      // The whole request costs at most the client's quota; a history is 5. NaN quotas stay NaN and deny.
      const quotaCap = this.scope ? Math.min(WEIGHT.history, this.scope.client.quotaPerHour) : WEIGHT.history;
      // Every charge inside this request (companion lookups included) reports a retry time for the whole request.
      const self = this.scope
        ? new RirService(this.deps, { bootstrap: this.bootstrap, fetcher: this.fetcher }, { ...this.scope, gate: metered(this.scope.gate, meter, quotaCap) })
        : this;
      const target = await self.historyTarget(req.type ?? inferHistoryType(req.resource), req);
      if ('kind' in target) return target;
      let redirected: Answer<{ readonly changed?: string }> | undefined;
      let servedBy: Rir = target.rir;
      if (target.rir !== 'apnic') {
        // The route may redirect to another RIR; only an APNIC-served record has APNIC history.
        redirected = await target.loadCurrent();
        if (redirected.kind === 'record') servedBy = redirected.meta.rir;
        if (servedBy !== 'apnic') {
          return { kind: 'error', code: 'history_unavailable', message: `Registration history is not published via RDAP by ${RIR_LABEL[servedBy]}; only APNIC provides it.` };
        }
      }
      const url = `${await this.bootstrap.baseUrl('apnic')}history/${target.path}`;
      const key = `hist:${target.path}`;
      // At most one companion lookup per history request; entity / reverse-DNS answers are reused.
      let companion: Answer<{ readonly changed?: string }> | undefined = target.preloaded ?? redirected;
      const load = async () => (companion ??= await target.loadCurrent());
      const force = await this.historyIsStale(key, load);
      // Any companion that reached upstream (miss, stale after failure, not_found) already spent a token.
      const misses = companion && ((companion.kind === 'record' && companion.meta.cache !== 'hit')
        || (companion.kind === 'error' && companion.code === 'not_found')) ? 1 : 0;
      const validatedFor = companion?.kind === 'record' ? companion.record.changed : undefined;
      // The whole request costs the client at most its quota (a history is 5; a key with a quota of 1-4 can still
      // ask, using its full hour). The RIR limiter is still charged the full weight. NaN quotas stay NaN and deny.
      const out = await this.get({
        key, rir: 'apnic', url, weight: Math.max(1, WEIGHT.history - misses), quotaWeight: Math.max(0, quotaCap - meter.units),
        // If refused, the retry time is for the whole request: next time the companion is usually cached, so the
        // history needs the full cap. A unit the companion already spent stays spent (refunding it would let refused
        // requests make free upstream lookups).
        quotaRetryWeight: quotaCap,
        freshS: TTL_S.history, staleS: TTL_S.historyStale,
        maxBytes: MAX_BYTES.history, force,
        reduce: (raw) => ({ ...reduceHistory(raw, { rir: 'apnic', query: target.query }), validatedFor }),
      });
      if (out.ok && out.value.personal) {
        return { kind: 'error', code: 'personal_record', message: `${target.query} is a personal record; this service does not disclose its history.` };
      }
      return this.toAnswer(out);
    });
  }

  private async historyTarget(type: HistoryType, req: HistoryRequest): Promise<HistoryTarget | NoRecord> {
    if (type === 'ip') {
      const p = parseIpOrCidr(req.resource);
      const query = formatPrefix(p);
      const special = specialUseForIp(p);
      if (special) return { kind: 'special', query, special };
      const denied = await this.admit(scanUnitForIp(p));
      if (denied) return denied;
      const route = await this.bootstrap.routeIp(p);
      if (!route) return notDelegated(query);
      return { rir: route.rir, path: `ip/${query}`, query, loadCurrent: () => this.ip(query) };
    }
    if (type === 'asn') {
      const n = parseAsn(req.resource);
      const special = specialUseForAsn(n);
      if (special) return { kind: 'special', query: `AS${n}`, special };
      const denied = await this.admit(scanUnitForAsn(n));
      if (denied) return denied;
      const route = await this.bootstrap.routeAsn(n);
      if (!route) return notDelegated(`AS${n}`);
      return { rir: route.rir, path: `autnum/${n}`, query: `AS${n}`, loadCurrent: () => this.asn(n) };
    }
    if (type === 'entity') {
      const handle = parseHandle(req.resource);
      const current = await this.entity(handle, req.rir);
      if (current.kind === 'error' && current.code !== 'not_found') return current;
      const rir = req.rir ?? inferRirFromHandle(handle) ?? 'apnic';
      return { rir, path: `entity/${encodeURIComponent(handle)}`, query: handle, loadCurrent: async () => current, preloaded: current };
    }
    const rd = await this.reverseDns(req.resource);
    if (rd.kind !== 'record') return rd;
    // The zone comes from the registry's record; use it in the history URL and output only if it is one of the
    // reverse zones computed from the address itself (audit 2026-10-06 L2).
    if (!reverseZones(parseIpOrCidr(req.resource)).includes(rd.record.zone)) {
      return { kind: 'error', code: 'history_unavailable', message: `The registry returned an unexpected reverse zone for ${formatPrefix(parseIpOrCidr(req.resource))}.` };
    }
    return { rir: rd.meta.rir, path: `domain/${rd.record.zone}`, query: rd.record.zone, loadCurrent: async () => rd, preloaded: rd };
  }

  /**
   * History is append-only. Refetch when the object's `last changed` date is later than the newest
   * cached history record, at most once per change date: the stored `validatedFor` records the date
   * a fetch was made against (spec §6).
   */
  private async historyIsStale(key: string, load: () => Promise<Answer<{ readonly changed?: string }>>): Promise<boolean> {
    const entry = await this.fetcher.peek<HistoryRecord>(key);
    if (!entry || !entry.value.found || !entry.value.value.latestFrom) return false;
    const current = await load();
    const changed = current.kind === 'record' ? current.record.changed : undefined;
    if (!changed) return false;
    return changed > entry.value.value.latestFrom && entry.value.value.validatedFor !== changed;
  }

  /** Scan detector: every query a scoped client makes counts, cache hits included (spec §7). */
  private async admit(unit: string): Promise<NoRecord | null> {
    if (!this.scope) return null;
    const g = await this.scope.gate.observe(this.scope.client, unit);
    if (g.ok) return null;
    const { code, message, retryAfterS } = gateDenied(g);
    return { kind: 'error', code, message, retryAfterS };
  }

  private get<T>(req: FetchRequest<T>): Promise<FetchOutcome<T>> {
    return this.fetcher.get(this.scope ? { ...req, scope: this.scope } : req);
  }

  private toAnswer<T>(out: FetchOutcome<T>): Answer<T> {
    if (!out.ok) return { kind: 'error', code: out.code, message: out.message, retryAfterS: out.retryAfterS };
    const ageS = Math.max(0, Math.round((this.clock.now() - out.fetchedAt) / 1000));
    return { kind: 'record', record: out.value, meta: { rir: out.rir, cache: out.cache, ageS, url: out.url } };
  }
}

/** A gate that passes everything through and counts the quota units a request really spent (charges minus refunds). */
function metered(gate: ClientGate, meter: { units: number }, retryAtLeast: number): ClientGate {
  return {
    charge: async (client, weight, retryWeight) => {
      const g = await gate.charge(client, weight, Math.max(retryWeight ?? weight, retryAtLeast));
      if (g.ok) meter.units += weight;
      return g;
    },
    refund: async (client, weight) => {
      await gate.refund(client, weight);
      meter.units = Math.max(0, meter.units - weight);
    },
    observe: (client, unit) => gate.observe(client, unit),
  };
}
