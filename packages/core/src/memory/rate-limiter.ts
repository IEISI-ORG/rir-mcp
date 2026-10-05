import type { AcquireResult, Clock, RateLimiter } from '../ports';
import { PENALTY_FACTOR, PENALTY_MS, type LimitProfile } from '../rdap/limits';
import type { StateMap } from './state-map';

export interface BucketState {
  tokens: number;
  updatedAt: number;
  penaltyUntil: number;
  windowStart: number;
  windowCount: number;
  /** An upstream asked us to stop (Retry-After) until this time. Absent in state stored before it existed. */
  blockedUntil?: number;
}

const HOUR_MS = 3_600_000;
/** Never below 1: a fractional burst would let a call cost less than one token. */
const burstOf = (p: LimitProfile): number => Math.max(1, p.burst);
/** An upstream Retry-After is honoured up to this long; a misconfigured huge value must not stop a RIR for days. */
const MAX_BLOCK_MS = HOUR_MS;
const EPSILON = 1e-9; // absorbs float error, e.g. 6 s x (10/60) = 0.9999999999999999

/** Token bucket per named bucket, with an optional fixed-window hourly cap. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly state: StateMap<BucketState>;
  private readonly profiles: Readonly<Record<string, LimitProfile>>;
  private readonly clock: Clock;

  constructor(profiles: Readonly<Record<string, LimitProfile>>, clock: Clock, state: StateMap<BucketState> = new Map()) {
    this.profiles = profiles;
    this.clock = clock;
    this.state = state;
  }

  async check(name: string, weight: number): Promise<AcquireResult> {
    const profile = this.profile(name);
    const now = this.clock.now();
    return this.refusal(profile, this.refill(name, profile, now), weight, now) ?? { ok: true };
  }

  async acquire(name: string, weight: number): Promise<AcquireResult> {
    const profile = this.profile(name);
    const now = this.clock.now();
    const s = this.refill(name, profile, now);
    // A refusal saves nothing: the refill is linear and capped, so recomputing it later from the older state gives
    // the same tokens, and a blocked registry must not cost a storage write per call (audit 2026-10-06 L1).
    const refused = this.refusal(profile, s, weight, now);
    if (refused) return refused;
    const cost = Math.min(weight, burstOf(profile));
    s.tokens = Math.max(0, s.tokens - cost);
    s.windowCount += weight;
    this.state.set(name, s);
    return { ok: true };
  }

  async penalise(name: string, retryAfterS?: number): Promise<void> {
    const profile = this.profiles[name];
    if (!profile) return;
    const now = this.clock.now();
    const s = this.refill(name, profile, now);
    s.tokens = 0;
    s.penaltyUntil = now + PENALTY_MS;
    if (retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS > 0) {
      // The registry asked us to stop: do so until then (keeping any later deadline), not just slow down.
      s.blockedUntil = Math.max(s.blockedUntil ?? 0, now + Math.min(retryAfterS * 1000, MAX_BLOCK_MS));
    }
    this.state.set(name, s);
  }

  private refusal(profile: LimitProfile, s: BucketState, weight: number, now: number): AcquireResult | null {
    if (s.blockedUntil !== undefined && now < s.blockedUntil) {
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((s.blockedUntil - now) / 1000)) };
    }
    if (profile.hourlyCap !== undefined && s.windowCount + weight > profile.hourlyCap) {
      return { ok: false, retryAfterS: Math.ceil((s.windowStart + HOUR_MS - now) / 1000) };
    }
    const cost = Math.min(weight, burstOf(profile));
    if (s.tokens + EPSILON < cost) {
      const rate = this.rate(profile, s, now);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - s.tokens) / rate - EPSILON)) };
    }
    return null;
  }

  private profile(name: string): LimitProfile {
    const profile = this.profiles[name];
    if (!profile) throw new Error(`No rate-limit profile for bucket "${name}"`);
    return profile;
  }

  private rate(profile: LimitProfile, s: BucketState, now: number): number {
    return profile.ratePerS * (now < s.penaltyUntil ? PENALTY_FACTOR : 1);
  }

  private refill(name: string, profile: LimitProfile, now: number): BucketState {
    const stored = this.state.get(name);
    const s: BucketState = stored
      ? { ...stored }
      : { tokens: burstOf(profile), updatedAt: now, penaltyUntil: 0, windowStart: now, windowCount: 0 };
    // A span that straddles the end of a penalty refills at the reduced rate up to penaltyUntil, full rate after.
    const penalised = Math.max(0, Math.min(now, s.penaltyUntil) - s.updatedAt);
    const normal = Math.max(0, now - Math.max(s.updatedAt, s.penaltyUntil));
    const gained = (penalised * PENALTY_FACTOR + normal) / 1000 * profile.ratePerS;
    s.tokens = Math.min(burstOf(profile), s.tokens + gained);
    // Never move the bucket's clock backwards: a backward step would let the same span be credited twice.
    s.updatedAt = Math.max(s.updatedAt, now);
    if (now - s.windowStart >= HOUR_MS) {
      s.windowStart = now;
      s.windowCount = 0;
    }
    return s;
  }
}
