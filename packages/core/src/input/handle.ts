import type { Rir } from '../rdap/rirs';
import { InputError } from './errors';

// Case-insensitive ASCII only: test before upper-casing, which maps some non-ASCII letters (ß, ı) into ASCII.
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const HANDLE_HINT = 'Use a registry handle such as ORG-ARAD1-AP or IRT-APNICRANDNET-AU.';

export function parseHandle(raw: string): string {
  const s = raw.trim();
  if (!HANDLE_RE.test(s)) throw new InputError(`Not a registry handle: "${raw}"`, HANDLE_HINT);
  return s.toUpperCase();
}

const SUFFIXES: ReadonlyArray<readonly [string, Rir]> = [
  ['-AFRINIC', 'afrinic'],
  ['-LACNIC', 'lacnic'],
  ['-ARIN', 'arin'],
  ['-RIPE', 'ripe'],
  ['-AP', 'apnic'],
];

/** Guess the RIR from a handle suffix; null when the suffix is not RIR-specific. */
export function inferRirFromHandle(handle: string): Rir | null {
  for (const [suffix, rir] of SUFFIXES) if (handle.endsWith(suffix)) return rir;
  return null;
}
