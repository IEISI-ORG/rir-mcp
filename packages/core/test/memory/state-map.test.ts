import { describe, expect, it } from 'vitest';
import { MemoryClientGate, type ClientState } from '../../src/memory/client-gate';
import { MemoryRateLimiter, type BucketState } from '../../src/memory/rate-limiter';
import type { StateMap } from '../../src/memory/state-map';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { FakeClock } from '../support/fake-clock';

/** Behaves like the SQLite map in the Durable Object: values go through JSON, so in-place edits are lost. */
class RecordingMap<V> implements StateMap<V> {
  readonly rows = new Map<string, string>();
  get(key: string): V | undefined {
    const text = this.rows.get(key);
    return text === undefined ? undefined : (JSON.parse(text) as V);
  }
  set(key: string, value: V): void {
    this.rows.set(key, JSON.stringify(value));
  }
}

const alpha = { clientId: 'alpha', quotaPerHour: 3 };

describe('MemoryRateLimiter over a persisted state map', () => {
  it('persists token spend and penalties, and a new instance continues from them', async () => {
    const clock = new FakeClock();
    const map = new RecordingMap<BucketState>();
    const a = new MemoryRateLimiter(DEFAULT_LIMITS, clock, map);
    for (let i = 0; i < 5; i++) expect((await a.acquire('apnic', 1)).ok).toBe(true);
    const b = new MemoryRateLimiter(DEFAULT_LIMITS, clock, map);
    expect((await b.acquire('apnic', 1)).ok).toBe(false);
    await b.penalise('arin');
    expect(map.get('arin')?.penaltyUntil).toBeGreaterThan(clock.now());
    expect((await new MemoryRateLimiter(DEFAULT_LIMITS, clock, map).acquire('arin', 1)).ok).toBe(false);
  });
});

describe('MemoryClientGate over a persisted state map', () => {
  it('persists quota use and refunds, and a new instance continues from them', async () => {
    const clock = new FakeClock();
    const map = new RecordingMap<ClientState>();
    const a = new MemoryClientGate(clock, { state: map, salt: 's' });
    await a.charge(alpha, 3);
    await a.refund(alpha, 1);
    expect(map.get('alpha')?.used).toBe(2);
    const b = new MemoryClientGate(clock, { state: map, salt: 's' });
    expect((await b.charge(alpha, 1)).ok).toBe(true);
    expect((await b.charge(alpha, 1)).ok).toBe(false);
  });

  it('persists scan units as JSON and suspends across instances at the threshold', async () => {
    const clock = new FakeClock();
    const map = new RecordingMap<ClientState>();
    const a = new MemoryClientGate(clock, { state: map, salt: 's', scanThreshold: 2 });
    await a.observe(alpha, 'as:1');
    await a.observe(alpha, 'as:2');
    expect(map.get('alpha')?.units).toHaveLength(2);
    const b = new MemoryClientGate(clock, { state: map, salt: 's', scanThreshold: 2 });
    expect((await b.observe(alpha, 'as:2')).ok).toBe(true);
    expect(await b.observe(alpha, 'as:3')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(map.get('alpha')?.suspendedUntil).toBeGreaterThan(clock.now());
    expect((await new MemoryClientGate(clock, { state: map, salt: 's' }).charge(alpha, 1)).ok).toBe(false);
  });
});
