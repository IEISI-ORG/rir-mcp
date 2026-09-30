// Control (Cc), format (Cf: zero-width, bidi, BOM, soft hyphen, tag characters) and private-use (Co).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}]/gu;

/** Registry text is data, never instructions: strip unsafe characters and cap length. */
export function clean(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return undefined;
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}
