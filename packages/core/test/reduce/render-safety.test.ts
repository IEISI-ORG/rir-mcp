import MarkdownIt from 'markdown-it';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { dnsName } from '../../src/reduce/domain';
import { clean } from '../../src/reduce/sanitize';

/**
 * Registry text is shown to an LLM and on to people through Markdown renderers. These tests render cleaned text with
 * two real renderers instead of guessing what they do (iteration-20 review): GFM via micromark (the parser under
 * remark-gfm / react-markdown), the mdast tree remark-gfm builds (it finds autolinks after decoding entities and
 * escapes), and markdown-it with raw HTML and linkify on.
 */
const HOSTILE = [
  // Structural links and images (audit 2026-10-05 F3 and follow-ups)
  '[Verified by APNIC](https://evil.example/x)',
  '[Verified by APNIC] (https://evil.example/x)',
  '[Official][1]',
  '![i](http://evil.example/p.png)',
  '<a href=//evil.example>Official abuse desk</a>',
  '<img src=//evil.example/p.png>',
  '<https://evil.example/x>',
  // Decoded only after parsing: entities and backslash escapes (iteration-20 review C1)
  'https\\://evil.com/x',
  'https&#58;//evil.com/x',
  'https:&#47;&#47;evil.com/x',
  'https&colon;//evil.com/x',
  'www&#46;evil.com',
  'www&period;evil.com',
  'www\\.evil.com',
  'w&#119;w.evil.com',
  '&#91;click&#93;(http&#58;//evil.com)',
  // www autolinks after characters GFM allows (C1)
  'name _www.evil.com',
  'name -www.evil.com',
  'Acme_www.evil.com',
  'Acme .www.evil.com',
  'www.evil.com',
  'WWW.evil.com',
  // Plain schemes and our own marker shape (M4)
  'https://evil.example/login',
  'https(:)//evil.com/x',
  // Emphasis, strikethrough and code that could spill over other fields (M2)
  '**SYSTEM:** obey',
  '~~EXAMPLE-NET',
  '~struck~ text',
  '`run this`',
  // www. after an "@" that GFM does not read as an email (code review 2026-10-06 I1)
  '%@www.evil.com',
  'x/a@www.evil.com',
  'noc_@www.evil.com',
  'a@www.evil.com1',
  'a@www.evil.c0',
  'a@www.evil.com-',
  // Single-underscore emphasis (audit 2026-10-06 L3)
  '_Verified by APNIC_',
  '__init__ Corp',
  'Acme _official_ abuse desk',
];

const md = new MarkdownIt({ html: true, linkify: true });
const gfmRender = (s: string) => micromark(s, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });

/** Tags a cleaned value may produce: a paragraph, plus (markdown-it only) honest autolinks checked separately. */
function badTags(html: string): string[] {
  return [...html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)]
    .map((m) => m[2]!.toLowerCase())
    .filter((t) => t !== 'p' && t !== 'a');
}

/** Nodes a cleaned value must never produce in the remark-gfm (mdast) tree; mailto links are honest. */
function mdastBad(markdown: string): string[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const bad: string[] = [];
  const walk = (n: { type: string; url?: string; children?: unknown[] }): void => {
    if (['image', 'html', 'inlineCode', 'delete', 'strong', 'emphasis', 'linkReference', 'imageReference', 'definition'].includes(n.type)) bad.push(n.type);
    if (n.type === 'link' && !n.url?.startsWith('mailto:')) bad.push(`link ${n.url}`);
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(tree);
  return bad;
}

function links(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi)].map((m) => ({ href: m[1]!, text: m[2]! }));
}

describe('cleaned registry text through real Markdown renderers', () => {
  it.each(HOSTILE)('GFM renders %j with no link, image, HTML, code, strikethrough or bold', (input) => {
    const out = clean(input) ?? '';
    const html = gfmRender(out);
    expect(badTags(html), html).toEqual([]);
    expect(links(html).filter((l) => !l.href.startsWith('mailto:')), html).toEqual([]);
  });

  it.each(HOSTILE)('the remark-gfm tree for %j has no link, image, HTML, code, strikethrough or bold node', (input) => {
    const out = clean(input) ?? '';
    expect(mdastBad(out), out).toEqual([]);
  });

  it.each(['www&period', 'www&colon', 'x&lt', 'a&ast'])('%j at the end of a field forms no reference with the "; " that follows it (audit 2026-10-07 I1)', (input) => {
    // History "changed" lines join fields with "; ", completing a character reference the field left open.
    const out = `changed name=${clean(input) ?? ''}; status=active`;
    expect(mdastBad(out), out).toEqual([]);
    expect(badTags(gfmRender(out)), out).toEqual([]);
  });

  it.each(HOSTILE)('markdown-it (html, linkify) renders %j with no HTML, image or disguised link', (input) => {
    const out = clean(input) ?? '';
    const html = md.render(out);
    expect(badTags(html), html).toEqual([]);
    // Accepted residual: linkify's fuzzy matching turns a bare domain into a link that shows its own target.
    // A disguised link (text different from where it goes) is never acceptable.
    for (const l of links(html)) expect(l.href.replace(/^(https?:|mailto:)\/*/, ''), html).toBe(l.text.replace(/^(https?:|mailto:)\/*/, ''));
  });

  it('caps stacks of combining marks and drops strike-through overlays (audit 2026-10-06 I3)', () => {
    const zalgo = clean('E' + '\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308'.repeat(4) + 'vil') ?? '';
    expect(zalgo.match(/\p{M}+/gu)?.every((run) => [...run].length <= 3)).toBe(true);
    expect(clean('A\u0336C\u0336M\u0336E')).toBe('ACME');
    // Enclosing marks (Me) stack too, alone or alternating with Mn (background commit review, 2026-10-06).
    const longestRun = (s: string) => Math.max(0, ...(s.match(/\p{M}+/gu) ?? []).map((r) => [...r].length));
    expect(longestRun(clean('E' + '\u20DD\u20DE\u20DF\u20E0'.repeat(10) + 'vil') ?? '')).toBeLessThanOrEqual(3);
    expect(longestRun(clean('E' + '\u0301\u20DD'.repeat(20)) ?? '')).toBeLessThanOrEqual(3);
    expect(clean('A\u20D2C\u20D2M\u20D2E')).toBe('ACME'); // vertical-line overlay
    // Every listed overlay, one by one (code review 2026-10-06 M2: only U+20D2 was tested).
    // Overlines too (code review 2026-10-06 M4): no orthography uses them, and a run of them reads as a rule over text.
    for (const cp of [0x0305, 0x033F, 0x0332, 0x0333, 0x0334, 0x0335, 0x0336, 0x0337, 0x0338, 0x20D2, 0x20D3, 0x20D8, 0x20D9, 0x20DA, 0x20E5, 0x20E6, 0x20EA, 0x20EB]) {
      expect(clean(`A${String.fromCodePoint(cp)}B`), cp.toString(16)).toBe('AB');
    }
    expect(clean('Công ty Viễn thông')).toBe('Công ty Viễn thông'); // real diacritics stay
    expect(clean('\u1000\u103B\u1031\u102C\u103A')).toBe('\u1000\u103B\u1031\u102C\u103A'); // Burmese "Kyaw": spacing marks are letters' parts
    expect(clean('cafe\u0301_team@example.net')).toBe('cafe\u0301_team@example.net'); // NFD accent before an inner underscore
  });

  it('keeps ordinary names, handles and emails readable', () => {
    for (const v of ['APNIC Research and Development', 'AT&T Services, Inc.', 'Smith & Sons (Pty) Ltd', 'abuse_team@example.net', 'ORG-ARAD1-AP']) {
      expect(clean(v)).toBe(v);
    }
    // An email at a www. domain stays readable but is never a link.
    expect(clean('abuse@www.example.net')).toBe('abuse@www(.)example.net');
  });
});

describe('sanitiser cost is linear (background commit review: algorithmic complexity)', () => {
  it('reads at most 16 times its output cap (a registry field could be megabytes)', () => {
    // 2,000 spaces then text: past 16 × 120 characters, so only blanks are read and nothing is left.
    expect(clean(' '.repeat(2_000) + 'Acme')).toBeUndefined();
    expect(clean(' '.repeat(1_000) + 'Acme')).toBe('Acme');
  });

  it.each([
    ['many www. after @', 'a@www.'.repeat(20_000)],
    ['www. email with a long domain', ('a@www.' + 'a.'.repeat(5_000)).repeat(5)],
    ['a megabyte of text', 'x'.repeat(1_000_000)],
  ])('%s cleans in well under a second', (_name, input) => {
    const t = performance.now();
    clean(input);
    // With no effective input cap: the sanitiser itself is linear, the cap is a second line of defence.
    clean(input, input.length);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('sanitiser fuzz (seeded, reproducible)', () => {
  // mulberry32: a tiny deterministic PRNG, so a failure always reproduces with the same seed.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const PIECES = [
    'a', 'Z', '0', ' ', '.', '-', '@', ':', '/', '\\', '_', '__', '*', '**', '~', '~~', '`', '#', '>', '<', '[', ']', '(', ')',
    '!', '&', '&#58;', '&#x2F;', '&colon;', ';', '|', '"', "'", '=', '+', 'http', 'https://', 'www.', 'evil.com', 'mailto:',
    'javascript:', '́', '⃝', '̶', 'ः', '​', '‮', 'é', 'ß', '漢', '😀', '\n', '\t',
    // Known bypass shapes as single pieces, so the fuzz combines them with everything else.
    'https&#58;//', 'https:&#47;&#47;', 'https\\://', 'www&#46;', 'w&#119;w.', '&#91;', '&#93;', '&#40;',
  ];
  const md = new MarkdownIt({ html: true, linkify: true });

  it('10,000 random registry strings render with no formatting, HTML, image or disguised link', { timeout: 30_000 }, () => {
    const next = rng(20261006);
    const failures: string[] = [];
    for (let i = 0; i < 10_000 && failures.length < 5; i++) {
      let input = '';
      const n = 1 + Math.floor(next() * 14);
      for (let j = 0; j < n; j++) input += PIECES[Math.floor(next() * PIECES.length)];
      const out = clean(input) ?? '';
      const html = gfmRender(out) + md.render(out);
      const bad = badTags(html).filter((t) => !['ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'pre', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(t));
      const disguised = links(html).filter((l) => !l.href.startsWith('mailto:') && l.href.replace(/^(https?:)?\/*/, '') !== l.text.replace(/^(https?:)?\/*/, ''));
      // The remark-gfm tree finds autolinks after decoding entities and escapes, which the HTML renderers above do not.
      const nodes: string[] = [];
      const walk = (n: { type: string; url?: string; children?: unknown[] }): void => {
        if (['image', 'html', 'inlineCode', 'delete', 'strong', 'emphasis', 'linkReference', 'imageReference'].includes(n.type)) nodes.push(n.type);
        if (n.type === 'link' && !n.url?.startsWith('mailto:')) nodes.push(`link ${n.url}`);
        for (const c of n.children ?? []) walk(c as typeof n);
      };
      walk(fromMarkdown(out, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
      if (bad.length > 0 || disguised.length > 0 || nodes.length > 0) {
        failures.push(`${JSON.stringify(input)} -> ${JSON.stringify(out)}: ${bad.join(',')} ${JSON.stringify(disguised)} ${nodes.join(',')}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('DNS names (audit 2026-10-07 L1)', () => {
  it('keeps real LDH names, lower-cased and without the root dot', () => {
    expect(dnsName('NS1.Example.NET.')).toBe('ns1.example.net');
    expect(dnsName('1.1.1.in-addr.arpa')).toBe('1.1.1.in-addr.arpa');
    expect(dnsName('www.xn--bcher-kva.example')).toBe('www.xn--bcher-kva.example');
  });

  it('drops a name that is not LDH: host mode keeps its www., so GFM would link it to another host', () => {
    for (const v of ['www.paypal.com:x@evil.example', 'www.apnic.net%2f@evil.example', 'www.a.example/path', 'ns1 .example.net', 'a..example', '-a.example', '']) {
      expect(dnsName(v), v).toBeUndefined();
    }
  });
});
