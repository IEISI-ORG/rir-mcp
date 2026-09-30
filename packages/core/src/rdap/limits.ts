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

export function clampProfile(requested: Partial<LimitProfile>, max: LimitProfile): LimitProfile {
  const profile: { ratePerS: number; burst: number; hourlyCap?: number } = {
    ratePerS: Math.min(requested.ratePerS ?? max.ratePerS, max.ratePerS),
    burst: Math.min(requested.burst ?? max.burst, max.burst),
  };
  const cap = requested.hourlyCap ?? max.hourlyCap;
  if (cap !== undefined) profile.hourlyCap = max.hourlyCap !== undefined ? Math.min(cap, max.hourlyCap) : cap;
  return profile;
}
