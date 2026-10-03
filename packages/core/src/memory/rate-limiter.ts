import type { AcquireResult, Clock, RateLimiter } from '../ports';
import { PENALTY_FACTOR, PENALTY_MS, type LimitProfile } from '../rdap/limits';
import type { StateMap } from './state-map';

export interface BucketState {
  tokens: number;
  updatedAt: number;
  penaltyUntil: number;
  windowStart: number;
  windowCount: number;
}

const HOUR_MS = 3_600_000;
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

  async acquire(name: string, weight: number): Promise<AcquireResult> {
    const profile = this.profile(name);
    const now = this.clock.now();
    const s = this.refill(name, profile, now);
    // Persist the refill whatever the outcome, so a persisted store sees the same state as memory would.
    this.state.set(name, s);
    if (profile.hourlyCap !== undefined && s.windowCount + weight > profile.hourlyCap) {
      return { ok: false, retryAfterS: Math.ceil((s.windowStart + HOUR_MS - now) / 1000) };
    }
    const cost = Math.min(weight, profile.burst);
    if (s.tokens + EPSILON < cost) {
      const rate = this.rate(profile, s, now);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - s.tokens) / rate - EPSILON)) };
    }
    s.tokens = Math.max(0, s.tokens - cost);
    s.windowCount += weight;
    this.state.set(name, s);
    return { ok: true };
  }

  async penalise(name: string): Promise<void> {
    const profile = this.profiles[name];
    if (!profile) return;
    const now = this.clock.now();
    const s = this.refill(name, profile, now);
    s.tokens = 0;
    s.penaltyUntil = now + PENALTY_MS;
    this.state.set(name, s);
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
      : { tokens: profile.burst, updatedAt: now, penaltyUntil: 0, windowStart: now, windowCount: 0 };
    s.tokens = Math.min(profile.burst, s.tokens + ((now - s.updatedAt) / 1000) * this.rate(profile, s, now));
    s.updatedAt = now;
    if (now - s.windowStart >= HOUR_MS) {
      s.windowStart = now;
      s.windowCount = 0;
    }
    return s;
  }
}
