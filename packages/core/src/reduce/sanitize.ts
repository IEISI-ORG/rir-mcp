// Control (Cc), format (Cf: zero-width, bidi, BOM, soft hyphen, tag characters), private-use (Co),
// lone surrogates (Cs), variation selectors, and letters that render blank (Hangul fillers, empty Braille).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/**
 * Registry text is shown to an LLM and on to people, so nothing in it may render as a link, image, HTML or code.
 * None of the cleaned fields (names, handles, emails, DNS names) legitimately holds a URL or markup.
 * - No square brackets: every Markdown link or image (inline, reference, lenient "[x] (url)") starts with "[".
 * - No angle brackets: no raw HTML (<a href=//…>, <img>) and no <https://…> autolinks.
 * - Schemes (also with Markdown-escaped slashes) and word-initial "www." are defanged, so bare autolinkers
 *   (GFM extended autolinks) find nothing. The markers use parentheses, never square brackets.
 * - Backticks become quotes (no code spans).
 * Emails and bare hostnames keep their "www." (abuse@www.example.net, a nameserver www.example.net).
 */
const BARE_HOST_OR_EMAIL = /^(?:[A-Za-z0-9._%+-]+@)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?$/;

function defang(s: string): string {
  const bare = BARE_HOST_OR_EMAIL.test(s);
  return s
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\\?\/\\?\//g, '$1(:)//')
    .replace(/(?<![@.\w-])www\./gi, (m) => (bare ? m : `${m.slice(0, 3)}(.)`))
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
