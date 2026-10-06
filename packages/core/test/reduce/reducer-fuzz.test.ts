import { describe, expect, it } from 'vitest';
import type { Rir } from '../../src/rdap/rirs';
import { RdapError } from '../../src/rdap/errors';
import { reduceAutnum } from '../../src/reduce/autnum';
import { reduceDomain } from '../../src/reduce/domain';
import { reduceEntity } from '../../src/reduce/entity';
import { reduceHistory } from '../../src/reduce/history';
import { reduceNetwork } from '../../src/reduce/network';
import { renderHistory } from '../../src/render/history';
import { renderAutnum, renderDomain, renderEntity, renderNetwork } from '../../src/render/text';
import type { Meta } from '../../src/service/answer';
import { listFixtures, loadFixture } from '../support/fixtures';

// mulberry32: a tiny deterministic PRNG, so a failure always reproduces with the same seed.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Values a broken or hostile registry might put anywhere in a response. */
const HOSTILE: unknown[] = [
  null, true, 0, -1, 1.5, 1e308, -0, '', 'x', '2010-13-45', '9999-99-99T99:99:99Z', '::', '300.1.1.1', '1.1.1.0/99',
  [], [null], [[]], [{}], {}, { a: 1 }, ['vcard'], ['vcard', null], ['vcard', [[null]]], ['vcard', [['fn', {}, 'text']]],
];

/** A deep copy of `v` with random subtrees replaced by hostile values or deleted. */
function mutate(v: unknown, next: () => number, rate: number): unknown {
  if (next() < rate) return HOSTILE[Math.floor(next() * HOSTILE.length)];
  if (Array.isArray(v)) return v.map((x) => mutate(x, next, rate));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (next() >= rate / 2) out[k] = mutate(x, next, rate);
    return out;
  }
  return v;
}

const meta: Meta = { rir: 'apnic', cache: 'miss', ageS: 0, url: 'https://rdap.apnic.net/x' };

type Run = (raw: unknown, rir: Rir) => string;
const KINDS: Array<[string, Run]> = [
  ['/ip/', (raw, rir) => renderNetwork(reduceNetwork(raw, { rir }), meta)],
  ['/autnum/', (raw, rir) => renderAutnum(reduceAutnum(raw, { rir }), meta)],
  ['/domain/', (raw, rir) => renderDomain(reduceDomain(raw, { rir }), meta)],
  ['/entity/', (raw, rir) => {
    const r = reduceEntity(raw, { rir });
    return r.type === 'personal-entity' ? '' : renderEntity(r, meta);
  }],
  ['/history-', (raw, rir) => {
    const h = reduceHistory(raw, { rir, query: '192.0.2.1' });
    return [renderHistory(h, meta, { detail: 'full' }), renderHistory(h, meta, { detail: 'summary', at: '2012-01-01' })].join('\n');
  }],
];

describe('reducers and renderers on corrupted registry data (seeded fuzz, Task 11 follow-up)', () => {
  // A reducer may refuse a response (RdapError), but must never crash on it: any other exception escapes the
  // fetcher as an internal error, without the stale fallback or the registry penalty.
  const fixtures = listFixtures('rdap').filter((f) => f.endsWith('.json'));

  it.each(fixtures)('%s: 300 corrupted copies reduce and render, or are refused with an RdapError', (file) => {
    const kind = KINDS.find(([part]) => file.includes(part));
    if (!kind) throw new Error(`no reducer for ${file}`);
    const rir = file.split('/')[1] as Rir;
    const original = loadFixture(file);
    const next = rng(file.length * 7919);
    const crashes: string[] = [];
    for (let i = 0; i < 300; i++) {
      const raw = mutate(original, next, [0.02, 0.1, 0.3][i % 3]!);
      try {
        expect(typeof kind[1](raw, rir)).toBe('string');
      } catch (err) {
        if (!(err instanceof RdapError)) crashes.push(`#${i}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      }
    }
    expect(crashes.slice(0, 5), `${crashes.length} crashes`).toEqual([]);
  }, 30_000);
});
