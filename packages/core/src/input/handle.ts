import type { Rir } from '../rdap/rirs';
import { InputError } from './errors';

const HANDLE_RE = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const HANDLE_HINT = 'Use a registry handle such as ORG-ARAD1-AP or IRT-APNICRANDNET-AU.';

export function parseHandle(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!HANDLE_RE.test(s)) throw new InputError(`Not a registry handle: "${raw}"`, HANDLE_HINT);
  return s;
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
