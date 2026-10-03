import { describe, expect, it } from 'vitest';
import { MemoryClientGate } from '../../src/memory/client-gate';
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
    expect((denied as { retryAfterS: number }).retryAfterS).toBe(3600);
    expect(await g.charge(beta, 1)).toEqual({ ok: true });
  });

  it('does not count denied charges and resets after the hour', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    await g.charge(alpha, 9);
    expect((await g.charge(alpha, 5)).ok).toBe(false);
    expect((await g.charge(alpha, 1)).ok).toBe(true);
    clock.advance(3_600_000);
    expect((await g.charge(alpha, 10)).ok).toBe(true);
  });
});

describe('MemoryClientGate quota hardening', () => {
  it.each([NaN, Infinity * 0, undefined as unknown as number])('fails closed on a non-numeric quota (%s)', async (q) => {
    const g = new MemoryClientGate(new FakeClock());
    expect(await g.charge({ clientId: 'x', quotaPerHour: q }, 1)).toMatchObject({ ok: false, reason: 'quota' });
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
