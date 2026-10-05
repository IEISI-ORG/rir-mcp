import type { Rir } from './rirs';

export interface LimitProfile {
  readonly ratePerS: number;
  readonly burst: number;
  readonly hourlyCap?: number;
}

/** Defaults are also the maximum an operator may configure (spec §6). */
export const DEFAULT_LIMITS: Readonly<Record<Rir, LimitProfile>> = {
  apnic: { ratePerS: 1, burst: 5 },
  arin: { ratePerS: 1, burst: 5 },
  ripe: { ratePerS: 1, burst: 5 },
  afrinic: { ratePerS: 1, burst: 5 },
  // LACNIC publishes 10/min and 1,000/hour per IP [LACNIC-RDAP].
  lacnic: { ratePerS: 10 / 60, burst: 3, hourlyCap: 1000 },
};

export const PENALTY_FACTOR = 0.5;
export const PENALTY_MS = 5 * 60_000;

/** An operator value that is not a finite positive number is ignored: NaN would otherwise disable the limit. */
const usable = (v: number | undefined): number | undefined => (v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined);

export function clampProfile(requested: Partial<LimitProfile>, max: LimitProfile): LimitProfile {
  const profile: { ratePerS: number; burst: number; hourlyCap?: number } = {
    ratePerS: Math.min(usable(requested.ratePerS) ?? max.ratePerS, max.ratePerS),
    // A burst below 1 would make each call cost a fraction of a token (more calls than the rate allows).
    burst: Math.min(Math.max(1, usable(requested.burst) ?? max.burst), max.burst),
  };
  // An hourly cap is a whole number of requests; anything else falls back to the published maximum.
  const h = requested.hourlyCap;
  const cap = h !== undefined && Number.isFinite(h) && h >= 1 ? Math.floor(h) : max.hourlyCap;
  if (cap !== undefined) profile.hourlyCap = max.hourlyCap !== undefined ? Math.min(cap, max.hourlyCap) : cap;
  return profile;
}
