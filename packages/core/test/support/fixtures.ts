import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rir } from '../../src/rdap/rirs';
import type { FakeRoute } from './fake-fetch';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

export function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8')) as unknown;
}

export function listFixtures(sub = ''): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push(relative(FIXTURES_DIR, p));
    }
  };
  walk(join(FIXTURES_DIR, sub));
  return out.sort();
}

/** Fixture paths look like rdap/<rir>/<kind>/<case>.json. */
export function rdapFixtures(kinds: readonly string[]): string[] {
  return listFixtures('rdap').filter((rel) => kinds.includes(rel.split('/')[2] ?? ''));
}

export function rirOf(rel: string): Rir {
  return rel.split('/')[1] as Rir;
}

export function ianaRoutes(): Record<string, FakeRoute> {
  const base = 'https://data.iana.org/rdap/';
  return {
    [`${base}ipv4.json`]: { body: loadFixture('iana/ipv4.json') },
    [`${base}ipv6.json`]: { body: loadFixture('iana/ipv6.json') },
    [`${base}asn.json`]: { body: loadFixture('iana/asn.json') },
  };
}
