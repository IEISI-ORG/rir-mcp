import { describe, expect, it } from 'vitest';
import { clearExpiredUnits, MemoryClientGate, type ClientState } from '../../src/memory/client-gate';
import { FakeClock } from '../support/fake-clock';

const alpha = { clientId: 'alpha', quotaPerHour: 10 };
const beta = { clientId: 'beta', quotaPerHour: 10 };

describe('MemoryClientGate quota', () => {
  it('allows weighted charges up to the hourly quota, per client', async () => {
    const g = new MemoryClientGate(new FakeClock());
    expect(await g.charge(alpha, 5)).toEqual({ ok: true });
    expect(await g.charge(alpha, 5)).toEqual({ ok: true });
    const denied = await g.charge(alpha, 1);
    expect(denied).toMatchObject({ ok: false, reason: 'quota' });
    // Sliding window: after the hour the previous hour's 10 still weigh 1.0, decaying; a weight-1 call fits once
    // the carry-over is down to 9, i.e. 6 minutes into the next hour.
    expect((denied as { retryAfterS: number }).retryAfterS).toBe(3960);
    expect(await g.charge(beta, 1)).toEqual({ ok: true });
  });

  it('does not count denied charges', async () => {
    const g = new MemoryClientGate(new FakeClock());
    await g.charge(alpha, 9);
    expect((await g.charge(alpha, 5)).ok).toBe(false);
    expect((await g.charge(alpha, 1)).ok).toBe(true);
  });
});

describe('MemoryClientGate sliding quota window (audit 2026-10-03 #5)', () => {
  const MIN = 60_000;

  it('refuses a burst across the hour boundary', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    expect((await g.charge(alpha, 1)).ok).toBe(true); // opens the window at t=0
    clock.advance(59 * MIN);
    expect((await g.charge(alpha, 9)).ok).toBe(true);
    clock.advance(2 * MIN); // one minute into the next hour: the previous 10 still weigh 59/60
    expect((await g.charge(alpha, 1)).ok).toBe(false);
  });

  it('lets the carry-over decay through the next hour, with an accurate retry time', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    await g.charge(alpha, 10);
    clock.advance(90 * MIN); // previous 10 weigh 0.5
    expect((await g.charge(alpha, 5)).ok).toBe(true);
    const denied = await g.charge(alpha, 1);
    expect(denied).toMatchObject({ ok: false, reason: 'quota', retryAfterS: 360 });
    clock.advance(6 * MIN); // weight 0.4: 4 + 5 + 1 = 10
    expect((await g.charge(alpha, 1)).ok).toBe(true);
  });

  it('resets fully after two idle hours', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    await g.charge(alpha, 10);
    clock.advance(120 * MIN);
    expect((await g.charge(alpha, 10)).ok).toBe(true);
  });

  it('reads state stored before the sliding window (no prevUsed) as no carry-over', async () => {
    const clock = new FakeClock();
    const state = new Map<string, ClientState>([
      ['alpha', { windowStart: clock.now(), used: 4, units: [], suspendedUntil: 0 } as unknown as ClientState],
    ]);
    const g = new MemoryClientGate(clock, { state });
    expect((await g.charge(alpha, 6)).ok).toBe(true);
    expect((await g.charge(alpha, 1)).ok).toBe(false);
  });
});

describe('MemoryClientGate full-quota charges', () => {
  // Heavy calls on small quotas are capped per request by the service (quotaWeight); the gate charges what it is given.
  it('allows a charge of the whole quota once the hour is free, and its retry time is real', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    const small = { clientId: 'small', quotaPerHour: 3 };
    expect((await g.charge(small, 3)).ok).toBe(true);
    const denied = await g.charge(small, 3);
    expect(denied).toMatchObject({ ok: false, reason: 'quota' });
    clock.advance((denied as { retryAfterS: number }).retryAfterS * 1000);
    expect((await g.charge(small, 3)).ok).toBe(true);
  });
});

describe('MemoryClientGate quota hardening', () => {
  it.each([NaN, Infinity * 0, undefined as unknown as number, 0, -1, 0.5])('fails closed on a non-numeric or sub-1 quota (%s)', async (q) => {
    const g = new MemoryClientGate(new FakeClock());
    expect(await g.charge({ clientId: 'x', quotaPerHour: q }, 1)).toMatchObject({ ok: false, reason: 'quota', retryAfterS: 3600 });
  });

  it('refunds charges that reached no upstream, never below zero', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    await g.charge(alpha, 10);
    await g.refund(alpha, 2);
    expect((await g.charge(alpha, 2)).ok).toBe(true);
    expect((await g.charge(alpha, 1)).ok).toBe(false);
    await g.refund(beta, 5);
    expect((await g.charge(beta, 10)).ok).toBe(true);
    expect((await g.charge(beta, 1)).ok).toBe(false);
  });
});

describe('MemoryClientGate scan detector', () => {
  it('counts distinct units, suspends above the threshold and alerts once', async () => {
    const clock = new FakeClock();
    const alerts: string[] = [];
    const g = new MemoryClientGate(clock, { scanThreshold: 3, onSuspend: (id) => alerts.push(id) });
    for (const u of ['v4:1.1.1.0/24', 'v4:1.1.1.0/24', 'v4:1.1.2.0/24', 'as:4608']) expect((await g.observe(alpha, u)).ok).toBe(true);
    expect(await g.observe(alpha, 'as:15169')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(await g.charge(alpha, 1)).toMatchObject({ ok: false, reason: 'suspended' });
    expect(await g.observe(alpha, 'as:1')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(alerts).toEqual(['alpha']);
    expect((await g.observe(beta, 'as:15169')).ok).toBe(true);
  });

  it('drops the scan digests once a client is suspended: only the suspension needs keeping', async () => {
    const state = new Map<string, ClientState>();
    const g = new MemoryClientGate(new FakeClock(), { scanThreshold: 2, state });
    for (const u of ['as:1', 'as:2', 'as:3']) await g.observe(alpha, u);
    expect(state.get('alpha')?.suspendedUntil).toBeGreaterThan(0);
    expect(state.get('alpha')?.units).toEqual([]);
  });

  it('lifts the suspension after suspendMs and starts a fresh count', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock, { scanThreshold: 1, suspendMs: 60_000 });
    await g.observe(alpha, 'a');
    expect((await g.observe(alpha, 'b')).ok).toBe(false);
    clock.advance(60_000);
    expect((await g.observe(alpha, 'c')).ok).toBe(true);
  });

  it('clears the distinct set when the hour rolls over', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock, { scanThreshold: 2 });
    await g.observe(alpha, 'a');
    await g.observe(alpha, 'b');
    clock.advance(3_600_000);
    expect((await g.observe(alpha, 'c')).ok).toBe(true);
    expect((await g.observe(alpha, 'd')).ok).toBe(true);
  });

  it('never stores the raw unit', async () => {
    const g = new MemoryClientGate(new FakeClock());
    await g.observe(alpha, 'v4:203.0.113.0/24');
    expect(JSON.stringify([...(g as unknown as { state: Map<string, { units: Set<string> }> }).state.values()].map((s) => [...s.units]))).not.toContain('203.0.113');
  });
});

describe('clearExpiredUnits', () => {
  it('clears digests of ended windows only, keeping counts and suspensions', () => {
    const HOUR = 3_600_000;
    const now = 10 * HOUR;
    const state = new Map<string, ClientState>([
      ['old', { windowStart: now - HOUR, used: 3, prevUsed: 0, units: ['aa'], suspendedUntil: 0 }],
      ['live', { windowStart: now - 1, used: 1, prevUsed: 0, units: ['bb'], suspendedUntil: 0 }],
    ]);
    clearExpiredUnits(state, now);
    expect(state.get('old')).toEqual({ windowStart: now - HOUR, used: 3, prevUsed: 0, units: [], suspendedUntil: 0 });
    expect(state.get('live')?.units).toEqual(['bb']);
  });
});

describe('MemoryClientGate call rate (audit 2026-10-05 F1)', () => {
  it('limits every call, cached ones included, to a per-client burst refilled per minute', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock, { callsPerMinute: 60, callBurst: 3 });
    for (let i = 0; i < 3; i++) expect((await g.observe(alpha, 'as:1')).ok).toBe(true);
    expect(await g.observe(alpha, 'as:1')).toEqual({ ok: false, reason: 'rate', retryAfterS: 1 });
    expect((await g.observe(beta, 'as:1')).ok).toBe(true); // per client
    clock.advance(1_000);
    expect((await g.observe(alpha, 'as:1')).ok).toBe(true);
  });

  it('does not write state for a repeated unit that changes nothing', async () => {
    const clock = new FakeClock();
    let writes = 0;
    const inner = new Map<string, ClientState>();
    const state = { get: (k: string) => inner.get(k), set: (k: string, v: ClientState) => { writes += 1; inner.set(k, v); } };
    const g = new MemoryClientGate(clock, { state });
    await g.observe(alpha, 'as:1');
    const afterFirst = writes;
    for (let i = 0; i < 10; i++) await g.observe(alpha, 'as:1');
    expect(writes).toBe(afterFirst);
    await g.observe(alpha, 'as:2');
    expect(writes).toBe(afterFirst + 1);
  });
});
