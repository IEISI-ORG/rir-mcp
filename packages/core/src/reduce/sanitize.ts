// Control (Cc), format (Cf: zero-width, bidi, BOM, soft hyphen, tag characters), private-use (Co),
// lone surrogates (Cs), variation selectors, and letters that render blank (Hangul fillers, empty Braille).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/**
 * Markdown that would render as a link, image or code span, and URLs, are defanged: registry text is shown to an
 * LLM and on to people, and none of the cleaned fields (names, handles, emails, DNS names) legitimately holds one.
 * A holder name like "[Verified by APNIC](https://…)" must not become a clickable "official" link.
 */
/** A bare hostname (a nameserver, a reverse zone) or email is data, not an injection: its www. stays as is. */
const BARE_HOST_OR_EMAIL = /^(?:[A-Za-z0-9._%+-]+@)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?$/;

function defang(s: string): string {
  const bare = BARE_HOST_OR_EMAIL.test(s);
  return s
    // Raw HTML (<a href=//…>, <img src=…>) and angle autolinks (<https://…>): no tag can survive without < >.
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    // Schemes, including Markdown-escaped slashes (https:\/\/ renders as https://).
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\\?\/\\?\//g, '$1[:]//')
    // GFM extended autolinks need no scheme: www.example.net/login.
    .replace(/(?<![@.\w-])www\./gi, (m) => (bare ? m : `${m.slice(0, 3)}[.]`))
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
