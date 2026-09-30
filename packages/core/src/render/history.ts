import { RIR_LABEL } from '../rdap/rirs';
import { historyChanges, stateAt, type Change, type Detail, type HistoryRecord, type ObjectHistory, type StateSummary } from '../reduce/history';
import type { Meta } from '../service/answer';
import { details, lines, sourceText } from './format';

export interface HistoryViewOpts {
  readonly detail: Detail;
  readonly since?: string;
  readonly at?: string;
}

const MAX_CHANGES = 20;
const MAX_COVERING = 3;
const MAX_LINE = 160;
const BUDGET_BYTES = 1500;
const cap = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const row = (date: string, label: string, text: string): string => `${date}  ${label.padEnd(11)}${text}`.trimEnd();
const holderLabel = (f: StateSummary): string =>
  f.holder === 'personal' ? 'private individual' : `${f.holder ?? '(none)'}${f.holderName ? ` (${f.holderName})` : ''}`;
const describe = (f: StateSummary): string =>
  [f.name, f.type, f.country, f.status, f.nameservers, f.holder ? `holder ${holderLabel(f)}` : undefined].filter(Boolean).join('  ');

function changeLine(c: Change): string {
  if (c.kind === 'withdrawn') return `${c.date}  withdrawn`;
  if (c.kind !== 'changed') return row(c.date, c.kind, describe(c.fields));
  const keys = Object.keys(c.fields) as Array<keyof StateSummary>;
  if (keys.length === 1 && keys[0] === 'name') return row(c.date, 'renamed', c.fields.name ?? '(none)');
  if (keys.every((k) => k === 'holder' || k === 'holderName')) return row(c.date, 'holder', holderLabel(c.fields));
  return row(c.date, 'changed', keys.map((k) => `${k}=${c.fields[k]}`).join('; '));
}

export interface Covering {
  readonly key: string;
  readonly name: string;
  readonly since: string;
}

function covering(o: ObjectHistory): Covering | null {
  const current = o.states.at(-1);
  if (o.prefixLength <= 0 || !current?.s) return null;
  let since = current.from;
  for (let i = o.states.length - 2; i >= 0; i--) {
    const s = o.states[i]?.s;
    if (!s || s.name !== current.s.name) break;
    since = o.states[i]?.from ?? since;
  }
  return { key: o.key, name: current.s.name ?? '', since };
}

const coveringLine = (c: Covering): string => `${'covering'.padEnd(12)}${c.key} ${c.name} (since ${c.since})`;

export type HistoryView =
  | { mode: 'empty'; query: string }
  | { mode: 'at'; query: string; at: string; key?: string; from?: string; until?: string; state: StateSummary | null; covered: boolean }
  | { mode: 'timeline'; key: string; rawRecords: number; totalChanges: number; omitted: number; changes: Change[]; covering: Covering[]; since?: string };

const sourceLine = (meta?: Meta): string => (meta ? lines([['source', sourceText(meta)]]) : '');

/** The single view shared by the text renderer and structured output; never exposes raw states. */
export function historyView(rec: HistoryRecord, opts: HistoryViewOpts, meta?: Meta): HistoryView {
  if (opts.at) {
    const hit = stateAt(rec, opts.at);
    if (!hit) return { mode: 'at', query: rec.query, at: opts.at, state: null, covered: false };
    return {
      mode: 'at', query: rec.query, at: opts.at, key: hit.object.key, from: hit.row.from,
      ...(hit.row.until ? { until: hit.row.until } : {}), state: hit.row.s ?? null, covered: true,
    };
  }
  const [primary, ...others] = rec.objects;
  if (!primary) return { mode: 'empty', query: rec.query };
  const all = historyChanges(primary, opts.detail, opts.since);
  const cover: Covering[] = [];
  for (const o of others) {
    const c = covering(o);
    if (c && cover.length < MAX_COVERING) cover.push(c);
  }
  let shown = all.slice(-MAX_CHANGES);
  const build = (): HistoryView => ({
    mode: 'timeline', key: primary.key, rawRecords: rec.rawRecords, totalChanges: all.length, omitted: all.length - shown.length,
    changes: shown, covering: cover, ...(opts.since ? { since: opts.since } : {}),
  });
  while (shown.length > 0 && byteLength(renderTimeline(build() as TimelineView, rec, meta)) >= BUDGET_BYTES) shown = shown.slice(1);
  return build();
}

type TimelineView = Extract<HistoryView, { mode: 'timeline' }>;

function renderTimeline(v: TimelineView, rec: HistoryRecord, meta?: Meta): string {
  const header = `${v.key}  history (${RIR_LABEL[rec.rir]} RDAP, ${v.rawRecords} records -> ${v.totalChanges} changes${v.since ? ` since ${v.since}` : ''})`;
  const note = v.omitted > 0 ? [`... ${v.omitted} earlier changes omitted; narrow with since=YYYY-MM-DD`] : [];
  return [header, ...note, ...v.changes.map((c) => cap(changeLine(c))), ...v.covering.map((c) => cap(coveringLine(c))), sourceLine(meta)].join('\n');
}

export function renderHistory(rec: HistoryRecord, meta: Meta, opts: HistoryViewOpts): string {
  const v = historyView(rec, opts, meta);
  if (v.mode === 'empty') return `${v.query}  no registration history found\n${sourceLine(meta)}`;
  if (v.mode === 'timeline') return renderTimeline(v, rec, meta);
  const header = `${v.query} on ${v.at} (${RIR_LABEL[rec.rir]} RDAP history)`;
  if (!v.covered) return `${header}\nno registration record covers that date\n${sourceLine(meta)}`;
  const s = v.state;
  return `${header}\n${lines([
    ['object', s ? `${v.key}  ${s.name ?? ''}`.trimEnd() + details(s.country, s.type, s.status) : `${v.key}  withdrawn`],
    ['holder', s?.holder ? holderLabel(s) : undefined],
    ['valid', `${v.from} .. ${v.until ?? 'now'}`],
    ['source', sourceText(meta)],
  ])}`;
}
