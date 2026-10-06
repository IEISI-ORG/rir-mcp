// Control (Cc), format (Cf: zero-width, bidi, BOM, soft hyphen, tag characters), private-use (Co), lone surrogates
// (Cs), unassigned (Cn), and everything Unicode marks default-ignorable (variation selectors, Hangul fillers, the
// combining grapheme joiner, reserved invisible ranges): none of it is visible, so it could carry a hidden payload.
// The empty Braille pattern renders blank too. Mongolian free variation selectors become spaces (accepted: rare in
// registry data, which uses Cyrillic for Mongolian).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Default_Ignorable_Code_Point}\u2800]/gu;

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
 *   letter or digit becomes "www(.)" (remark-gfm also autolinks after "_", "-", "." and even "@"). Emails get it too
 *   (abuse@www(.)example.net): keeping it for "complete" emails meant matching three renderers' email grammars, and
 *   every mismatch left a live link (code review 2026-10-06). DNS-name fields do not come
 *   here: dnsName accepts only LDH names.
 * - "~" (GFM strikes through even single tildes), "*" (bold and italics), "_" at a word edge (emphasis), and
 *   backticks (code) are neutralised; "_" inside a word (abuse_team@) is kept.
 * Accepted residual: linkifiers with fuzzy matching (markdown-it, Slack) link a bare domain such as "evil.com", but
 * such a link shows exactly where it goes. Protocol-relative "//host" is closed: "//" never survives.
 */
function defang(s: string): string {
  return s
    .replace(/\\/g, '∖')
    // Also at the end of the field: history lines join fields with "; ", which would complete the reference.
    .replace(/&(?=#|[A-Za-z][A-Za-z0-9]*(?:;|$))/g, '＆')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    // Every "://" (any scheme): matching the scheme name first backtracked quadratically on long runs of letters.
    .replace(/:\/\//g, '(:)(/)(/)')
    // Any other "//" too: linkifiers turn a protocol-relative "//host" into a link (and IDN hosts make its target
    // differ from its text). Names, handles and emails never contain one.
    .replace(/\/{2,}/g, (m) => '(/)'.repeat(m.length))
    .replace(/(?<![\p{L}\p{N}])www\./giu, (m) => `${m.slice(0, 3)}(.)`)
    .replace(/~/g, '∼')
    .replace(/\*/g, '∗')
    .replace(/_{2,}/g, '_')
    // A single '_' at a word edge starts or ends emphasis; inside a word (abuse_team@) it is kept.
    .replace(/(?<![\p{L}\p{N}\p{M}])_|_(?![\p{L}\p{N}])/gu, '‗')
    .replace(/`/g, "'");
}

/** Registry text is data, never instructions: strip unsafe characters, defang markup, and cap length. */
// Combining overlays, overlines and underlines fake strike-through or underline; long stacks of combining marks
// ("Zalgo") overflow lines. Real diacritics use at most two or three marks per letter.
// Overlays, overlines and underlines that fake strike-through or rules: U+0305, U+033F, U+0332-U+0338 and the
// combining-symbol overlays.
const OVERLAYS = /[\u0305\u033F\u0332-\u0338\u20D2\u20D3\u20D8-\u20DA\u20E5\u20E6\u20EA\u20EB]/g;
// Non-spacing (Mn) and enclosing (Me) marks stack visually, alone or mixed; spacing marks (Mc, e.g. Burmese vowel
// signs) are parts of letters and do not count.
const MARK_STACK = /([\p{Mn}\p{Me}]{3})[\p{Mn}\p{Me}]+/gu;

export function clean(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  // The output is at most `max` characters: never process more than a generous multiple of that (a registry field
  // could be megabytes). A cut through a surrogate pair is removed by UNSAFE below.
  const bounded = value.length > max * 16 ? value.slice(0, max * 16) : value;
  const marks = bounded.replace(OVERLAYS, '').replace(MARK_STACK, '$1');
  const s = defang(marks.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim());
  if (s === '') return undefined;
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}
