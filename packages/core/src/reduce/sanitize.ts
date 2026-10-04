// Control (Cc), format (Cf: zero-width, bidi, BOM, soft hyphen, tag characters), private-use (Co),
// lone surrogates (Cs), variation selectors, and letters that render blank (Hangul fillers, empty Braille).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/**
 * Markdown that would render as a link, image or code span, and URLs, are defanged: registry text is shown to an
 * LLM and on to people, and none of the cleaned fields (names, handles, emails, DNS names) legitimately holds one.
 * A holder name like "[Verified by APNIC](https://…)" must not become a clickable "official" link.
 */
function defang(s: string): string {
  return s
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\/\//g, '$1[:]//')
    .replace(/\]\s*\(/g, '] (')
    .replace(/!\[/g, '! [')
    .replace(/`/g, "'");
}

/** Registry text is data, never instructions: strip unsafe characters, defang links, and cap length. */
export function clean(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = defang(value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim());
  if (s === '') return undefined;
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}
