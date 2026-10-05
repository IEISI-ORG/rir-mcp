import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import { clampProfile, DEFAULT_LIMITS } from '../../src/rdap/limits';
import { FakeClock } from '../support/fake-clock';

describe('MemoryRateLimiter', () => {
  it('allows the burst, then refills at the sustained rate', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    for (let i = 0; i < 5; i++) expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: false, retryAfterS: 1 });
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
  });

  it('charges history lookups weight 5', async () => {
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, new FakeClock());
    expect(await lim.acquire('apnic', 5)).toEqual({ ok: true });
    expect(await lim.acquire('apnic', 1)).toMatchObject({ ok: false });
  });

  it('keeps RIR buckets independent', async () => {
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, new FakeClock());
    await lim.acquire('ripe', 5);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
  });

  it('applies the LACNIC profile: burst 3, then one request per 6 s', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    for (let i = 0; i < 3; i++) expect(await lim.acquire('lacnic', 1)).toEqual({ ok: true });
    expect(await lim.acquire('lacnic', 1)).toEqual({ ok: false, retryAfterS: 6 });
    clock.advance(6_000);
    expect(await lim.acquire('lacnic', 1)).toEqual({ ok: true });
  });

  it('enforces an hourly cap', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter({ x: { ratePerS: 1000, burst: 1000, hourlyCap: 3 } }, clock);
    for (let i = 0; i < 3; i++) expect(await lim.acquire('x', 1)).toEqual({ ok: true });
    expect(await lim.acquire('x', 1)).toEqual({ ok: false, retryAfterS: 3600 });
    clock.advance(3_600_000);
    expect(await lim.acquire('x', 1)).toEqual({ ok: true });
  });

  it('penalise empties the bucket and halves the refill rate for 5 minutes', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    await lim.penalise('apnic');
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toMatchObject({ ok: false });
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
  });

  it('honours an upstream Retry-After: refuses the bucket until then, capped at one hour', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    await lim.penalise('apnic', 600);
    clock.advance(599_000);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: false, retryAfterS: 1 });
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
    await lim.penalise('arin', 86_400); // a day: capped at an hour
    clock.advance(3_600_000);
    expect(await lim.acquire('arin', 1)).toEqual({ ok: true });
  });

  it('keeps the later of two Retry-After deadlines', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    await lim.penalise('apnic', 600);
    await lim.penalise('apnic', 60);
    clock.advance(120_000);
    expect((await lim.acquire('apnic', 1)).ok).toBe(false);
  });

  it.each([NaN, 0, -1, Infinity, 0.5])('clampProfile never lets an operator value (%s) loosen or disable a limit', async (bad) => {
    const p = clampProfile({ ratePerS: bad, burst: bad, hourlyCap: bad }, DEFAULT_LIMITS.lacnic);
    expect(p).toEqual(DEFAULT_LIMITS.lacnic);
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter({ lacnic: p }, clock);
    for (let i = 0; i < 3; i++) expect((await lim.acquire('lacnic', 1)).ok).toBe(true);
    expect((await lim.acquire('lacnic', 1)).ok).toBe(false);
  });

  it('does not over-refill across the end of a penalty', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter({ x: { ratePerS: 1, burst: 1000 } }, clock);
    for (let i = 0; i < 1000; i++) await lim.acquire('x', 1);
    await lim.penalise('x');
    clock.advance(310_000); // 300 s at 0.5/s = 150, then 10 s at 1/s = 10: 160 tokens, not 310
    expect((await lim.acquire('x', 160)).ok).toBe(true);
    expect((await lim.acquire('x', 1)).ok).toBe(false);
  });

  it('restores the full rate after the penalty', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    await lim.penalise('apnic');
    clock.advance(300_000);
    for (let i = 0; i < 5; i++) await lim.acquire('apnic', 1);
    clock.advance(1_000);
    expect((await lim.acquire('apnic', 1)).ok).toBe(true); // 1/s again
  });

  it('treats a burst below 1 as 1, so calls never cost less than a token', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter({ x: { ratePerS: 1, burst: 0.25 } }, clock);
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      if ((await lim.acquire('x', 1)).ok) ok++;
      clock.advance(250);
    }
    expect(ok).toBeLessThanOrEqual(11); // 1 per second over 10 s, not 4 per second
  });

  it('throws for an unknown bucket', async () => {
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, new FakeClock());
    await expect(lim.acquire('nope', 1)).rejects.toThrow('No rate-limit profile');
  });
});

describe('clampProfile', () => {
  it('lets operators lower limits but never raise them', () => {
    expect(clampProfile({ ratePerS: 5, burst: 2 }, DEFAULT_LIMITS.apnic)).toEqual({ ratePerS: 1, burst: 2 });
    expect(clampProfile({ hourlyCap: 5000 }, DEFAULT_LIMITS.lacnic)).toEqual({ ratePerS: 10 / 60, burst: 3, hourlyCap: 1000 });
  });
});
