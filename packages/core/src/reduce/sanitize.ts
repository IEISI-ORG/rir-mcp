// Control (Cc), format (Cf: zero-width, bidi, BOM, soft hyphen, tag characters), private-use (Co),
// lone surrogates (Cs), variation selectors, and letters that render blank (Hangul fillers, empty Braille).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/**
 * Registry text is shown to an LLM and on to people through Markdown renderers, so nothing in it may render as a
 * link, image, HTML, code, strikethrough or bold. None of the cleaned fields (names, handles, emails, DNS names)
 * legitimately holds a URL or markup. test/reduce/render-safety.test.ts checks this with real renderers (GFM via
 * micromark, the remark-gfm tree, markdown-it with HTML and linkify), so a new bypass shows up as a failing test.
 * - Backslashes and character references go first: remark-gfm finds autolinks after decoding them, so
 *   "https&#58;//x" or "www\.x" would otherwise slip past the rules below. "AT&T" is untouched.
 * - No square brackets: every Markdown link or image (inline, reference, lenient "[x] (url)") starts with "[".
 * - No angle brackets: no raw HTML (<a href=//…>, <img>) and no <https://…> autolinks.
 * - Schemes become "x(:)(/)(/)" (no "//" left for protocol-relative linkifiers), and "www." after anything but a
 *   letter, digit or "@" becomes "www(.)" (GFM also autolinks after "_", "-", "."). Emails keep theirs via "@";
 *   DNS-name fields pass { host: true } and keep a leading "www.".
 * - "~" (GFM strikes through even single tildes), "*" (bold and italics), "_" at a word edge (emphasis), and
 *   backticks (code) are neutralised; "_" inside a word (abuse_team@) is kept.
 * Accepted residual: linkifiers with fuzzy matching (markdown-it, Slack) link a bare domain such as "evil.com", but
 * such a link shows exactly where it goes.
 */
function defang(s: string, host: boolean): string {
  return s
    .replace(/\\/g, '∖')
    .replace(/&(?=#|[A-Za-z][A-Za-z0-9]*;)/g, '＆')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\/\//g, '$1(:)(/)(/)')
    .replace(/(?<![\p{L}\p{N}@])www\./giu, (m) => (host && s.toLowerCase().startsWith(m.toLowerCase()) ? m : `${m.slice(0, 3)}(.)`))
    .replace(/~/g, '∼')
    .replace(/\*/g, '∗')
    .replace(/_{2,}/g, '_')
    // A single '_' at a word edge starts or ends emphasis; inside a word (abuse_team@) it is kept.
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '‗')
    .replace(/`/g, "'");
}

/** Registry text is data, never instructions: strip unsafe characters, defang markup, and cap length. */
// Combining overlays and underlines (U+0332-U+0338) fake strike-through or underline; long stacks of combining marks
// ("Zalgo") overflow lines. Real diacritics use at most two or three marks per letter.
const OVERLAYS = /[\u0332-\u0338]/g;
const MARK_STACK = /(\p{M}{3})\p{M}+/gu;

export function clean(value: unknown, max = 120, opts: { readonly host?: boolean } = {}): string | undefined {
  if (typeof value !== 'string') return undefined;
  const marks = value.replace(OVERLAYS, '').replace(MARK_STACK, '$1');
  const s = defang(marks.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim(), opts.host === true);
  if (s === '') return undefined;
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}
