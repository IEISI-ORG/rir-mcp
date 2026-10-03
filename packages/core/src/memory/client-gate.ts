import type { ClientGate, ClientInfo, Clock, GateResult } from '../ports';

export const SCAN_THRESHOLD = 200;
export const SUSPEND_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OK: GateResult = { ok: true };

interface ClientState {
  windowStart: number;
  used: number;
  units: Set<string>;
  suspendedUntil: number;
}

export interface ClientGateOptions {
  readonly onSuspend?: (clientId: string) => void;
  readonly scanThreshold?: number;
  readonly suspendMs?: number;
}

export class MemoryClientGate implements ClientGate {
  private readonly state = new Map<string, ClientState>();
  private readonly clock: Clock;
  private readonly opts: Required<Pick<ClientGateOptions, 'scanThreshold' | 'suspendMs'>> & ClientGateOptions;
  private readonly salt = crypto.getRandomValues(new Uint8Array(16)).join('.');

  constructor(clock: Clock, opts: ClientGateOptions = {}) {
    this.clock = clock;
    this.opts = { scanThreshold: SCAN_THRESHOLD, suspendMs: SUSPEND_MS, ...opts };
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
    return OK;
  }

  async refund(client: ClientInfo, weight: number): Promise<void> {
    const s = this.current(client.clientId, this.clock.now());
    s.used = Math.max(0, s.used - weight);
  }

  async observe(client: ClientInfo, unit: string): Promise<GateResult> {
    const now = this.clock.now();
    const s = this.current(client.clientId, now);
    if (now < s.suspendedUntil) return this.suspended(s, now);
    s.units.add(await this.digest(unit));
    if (s.units.size <= this.opts.scanThreshold) return OK;
    s.suspendedUntil = now + this.opts.suspendMs;
    try { this.opts.onSuspend?.(client.clientId); } catch { /* alerting must not break answering */ }
    return this.suspended(s, now);
  }

  private current(clientId: string, now: number): ClientState {
    let s = this.state.get(clientId);
    if (!s) {
      s = { windowStart: now, used: 0, units: new Set(), suspendedUntil: 0 };
      this.state.set(clientId, s);
    }
    if (now >= s.suspendedUntil && s.suspendedUntil !== 0) {
      s.suspendedUntil = 0;
      s.windowStart = now;
      s.used = 0;
      s.units.clear();
    }
    if (now - s.windowStart >= HOUR_MS) {
      s.windowStart = now;
      s.used = 0;
      s.units.clear();
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
