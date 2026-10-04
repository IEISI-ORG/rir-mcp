import type { ClientGate, ClientInfo, Clock, GateResult } from '../ports';
import type { StateMap } from './state-map';

export const SCAN_THRESHOLD = 200;
export const SUSPEND_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OK: GateResult = { ok: true };

export interface ClientState {
  windowStart: number;
  used: number;
  /** Charges in the previous hour; they still count, weighted by how much of that hour is within the last 60 min. */
  prevUsed: number;
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
    // Sliding window (audit 2026-10-03 #5): the previous hour's charges decay linearly, so a full quota spent at
    // 00:59 cannot be spent again at 01:00. Written as !(<=) so a NaN or missing quota denies instead of allowing all.
    const elapsed = now - s.windowStart;
    const carried = s.prevUsed * (1 - elapsed / HOUR_MS);
    if (!(carried + s.used + weight <= client.quotaPerHour)) {
      return { ok: false, reason: 'quota', retryAfterS: retryAfter(s, elapsed, weight, client.quotaPerHour) };
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
    // Suspension makes the digests irrelevant until it ends (current() resets the window), so drop them now.
    s.units = [];
    this.state.set(client.clientId, s);
    try { this.opts.onSuspend?.(client.clientId); } catch { /* alerting must not break answering */ }
    return this.suspended(s, now);
  }

  private current(clientId: string, now: number): ClientState {
    const stored = this.state.get(clientId);
    const s: ClientState = stored
      ? { ...stored, prevUsed: stored.prevUsed ?? 0, units: [...stored.units] }
      : { windowStart: now, used: 0, prevUsed: 0, units: [], suspendedUntil: 0 };
    if (now >= s.suspendedUntil && s.suspendedUntil !== 0) {
      s.suspendedUntil = 0;
      s.windowStart = now;
      s.used = 0;
      s.prevUsed = 0;
      s.units = [];
    }
    const elapsed = now - s.windowStart;
    if (elapsed >= 2 * HOUR_MS) {
      s.windowStart = now;
      s.used = 0;
      s.prevUsed = 0;
      s.units = [];
    } else if (elapsed >= HOUR_MS) {
      // Windows stay aligned so the carry-over weight is exact.
      s.windowStart += HOUR_MS;
      s.prevUsed = s.used;
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

/**
 * Clears the scan digests of every client whose hourly window has ended, keeping counts and suspensions: the
 * in-memory counterpart of the Worker's alarm purge, for clients that stop querying. Run it periodically.
 */
export function clearExpiredUnits(state: Map<string, ClientState>, now: number): void {
  for (const [id, s] of state) {
    if (s.units.length > 0 && now - s.windowStart >= HOUR_MS) state.set(id, { ...s, units: [] });
  }
}

/** Seconds until `weight` fits under the sliding window, given the state at `elapsed` into its window. */
function retryAfter(s: ClientState, elapsed: number, weight: number, quota: number): number {
  const ms = s.used + weight <= quota
    // Blocked only by the carry-over: wait until prevUsed * (1 - t/H) <= quota - used - weight.
    ? HOUR_MS * (1 - (quota - s.used - weight) / s.prevUsed) - elapsed
    // The current hour alone is over: after it ends it becomes the carry-over, which must then decay enough.
    : HOUR_MS - elapsed + HOUR_MS * Math.max(0, Math.min(1, 1 - (quota - weight) / s.used));
  // A NaN quota (already denied, fail closed) must still give a usable retry time.
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : HOUR_MS / 1000;
}
