// C0/C1 controls, zero-width, bidi embeddings/overrides/isolates, BOM.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Registry text is data, never instructions: strip unsafe characters and cap length. */
export function clean(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
