import type { ClientGate, ClientInfo, Clock, GateResult } from '../ports';
import type { StateMap } from './state-map';

export const SCAN_THRESHOLD = 200;
export const SUSPEND_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OK: GateResult = { ok: true };

export interface ClientState {
  windowStart: number;
  used: number;
  /** Salted, truncated digests of the distinct scan units seen this window (never the units themselves). */
  units: string[];
  suspendedUntil: number;
}

export interface ClientGateOptions {
  readonly onSuspend?: (clientId: string) => void;
  readonly scanThreshold?: number;
  readonly suspendMs?: number;
  /** Where per-client state lives; defaults to process memory. */
  readonly state?: StateMap<ClientState>;
  /** Digest salt; must be stable for as long as `state` persists (the Durable Object stores one). */
  readonly salt?: string;
}

export class MemoryClientGate implements ClientGate {
  private readonly state: StateMap<ClientState>;
  private readonly clock: Clock;
  private readonly opts: Required<Pick<ClientGateOptions, 'scanThreshold' | 'suspendMs'>> & ClientGateOptions;
  private readonly salt: string;

  constructor(clock: Clock, opts: ClientGateOptions = {}) {
    this.clock = clock;
    this.opts = { scanThreshold: SCAN_THRESHOLD, suspendMs: SUSPEND_MS, ...opts };
    this.state = opts.state ?? new Map();
    this.salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16)).join('.');
  }

  async charge(client: ClientInfo, weight: number): Promise<GateResult> {
    const now = this.clock.now();
    const s = this.current(client.clientId, now);
    if (now < s.suspendedUntil) return this.suspended(s, now);
    // Written as !(<=) so a NaN or missing quota denies instead of allowing everything.
    if (!(s.used + weight <= client.quotaPerHour)) {
      return { ok: false, reason: 'quota', retryAfterS: Math.ceil((s.windowStart + HOUR_MS - now) / 1000) };
    }
    s.used += weight;
    this.state.set(client.clientId, s);
    return OK;
  }

  async refund(client: ClientInfo, weight: number): Promise<void> {
    const s = this.current(client.clientId, this.clock.now());
    s.used = Math.max(0, s.used - weight);
    this.state.set(client.clientId, s);
  }

  async observe(client: ClientInfo, unit: string): Promise<GateResult> {
    // Digest first: no await between reading and writing state keeps the update atomic in a Durable Object.
    const digest = await this.digest(unit);
    const now = this.clock.now();
    const s = this.current(client.clientId, now);
    if (now < s.suspendedUntil) return this.suspended(s, now);
    if (!s.units.includes(digest)) s.units.push(digest);
    if (s.units.length <= this.opts.scanThreshold) {
      this.state.set(client.clientId, s);
      return OK;
    }
    s.suspendedUntil = now + this.opts.suspendMs;
    this.state.set(client.clientId, s);
    try { this.opts.onSuspend?.(client.clientId); } catch { /* alerting must not break answering */ }
    return this.suspended(s, now);
  }

  private current(clientId: string, now: number): ClientState {
    const stored = this.state.get(clientId);
    const s: ClientState = stored
      ? { ...stored, units: [...stored.units] }
      : { windowStart: now, used: 0, units: [], suspendedUntil: 0 };
    if (now >= s.suspendedUntil && s.suspendedUntil !== 0) {
      s.suspendedUntil = 0;
      s.windowStart = now;
      s.used = 0;
      s.units = [];
    }
    if (now - s.windowStart >= HOUR_MS) {
      s.windowStart = now;
      s.used = 0;
      s.units = [];
    }
    return s;
  }

  private suspended(s: ClientState, now: number): GateResult {
    return { ok: false, reason: 'suspended', retryAfterS: Math.ceil((s.suspendedUntil - now) / 1000) };
  }

  /** Salted, truncated digest: distinct counting without keeping the queried value. */
  private async digest(unit: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${unit}`));
    return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
