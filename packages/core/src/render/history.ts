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

function coveringLine(o: ObjectHistory): string | null {
  const current = o.states.at(-1);
  if (o.prefixLength <= 0 || !current?.s) return null;
  let since = current.from;
  for (let i = o.states.length - 2; i >= 0; i--) {
    const s = o.states[i]?.s;
    if (!s || s.name !== current.s.name) break;
    since = o.states[i]?.from ?? since;
  }
  return `${'covering'.padEnd(12)}${o.key} ${current.s.name ?? ''} (since ${since})`;
}

function renderAt(rec: HistoryRecord, meta: Meta, at: string): string {
  const header = `${rec.query} on ${at} (${RIR_LABEL[rec.rir]} RDAP history)`;
  const hit = stateAt(rec, at);
  if (!hit) return `${header}\nno registration record covers that date\n${lines([['source', sourceText(meta)]])}`;
  const s = hit.row.s;
  return `${header}\n${lines([
    ['object', s ? `${hit.object.key}  ${s.name ?? ''}`.trimEnd() + details(s.country, s.type, s.status) : `${hit.object.key}  withdrawn`],
    ['holder', s?.holder ? holderLabel(s) : undefined],
    ['valid', `${hit.row.from} .. ${hit.row.until ?? 'now'}`],
    ['source', sourceText(meta)],
  ])}`;
}

export function renderHistory(rec: HistoryRecord, meta: Meta, opts: HistoryViewOpts): string {
  if (opts.at) return renderAt(rec, meta, opts.at);
  const [primary, ...others] = rec.objects;
  if (!primary) return `${rec.query}  no registration history found\n${lines([['source', sourceText(meta)]])}`;
  const changes = historyChanges(primary, opts.detail, opts.since);
  const shown = changes.slice(-MAX_CHANGES);
  const out = [
    `${primary.key}  history (${RIR_LABEL[rec.rir]} RDAP, ${rec.rawRecords} records -> ${changes.length} changes${opts.since ? ` since ${opts.since}` : ''})`,
  ];
  if (shown.length < changes.length) out.push(`... ${changes.length - shown.length} earlier changes omitted; narrow with since=YYYY-MM-DD`);
  out.push(...shown.map(changeLine));
  for (const o of others) {
    const line = coveringLine(o);
    if (line) out.push(line);
  }
  out.push(lines([['source', sourceText(meta)]]));
  return out.join('\n');
}
