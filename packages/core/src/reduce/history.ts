import { parseIpOrCidr } from '../input/ip';
import { RdapError } from '../rdap/errors';
import type { Rir } from '../rdap/rirs';
import { flattenEntities, partyFor } from './entities';
import { prefixesOf } from './network';
import { clean } from './sanitize';
import { isPersonal, type Party } from './types';
import { asObject, strings, type Obj } from './util';
import { isPersonLike, vcardValue } from './vcard';

export type Detail = 'summary' | 'full';

export interface StateSummary {
  readonly name?: string;
  readonly status?: string;
  readonly country?: string;
  readonly type?: string;
  readonly nameservers?: string;
  readonly holder?: string;
  readonly holderName?: string;
  readonly abuse?: string;
  readonly tech?: string;
  readonly admin?: string;
}
type Field = keyof StateSummary;

export interface StateRow {
  readonly from: string;
  readonly until?: string;
  readonly s: StateSummary | null;
}

export interface ObjectHistory {
  readonly key: string;
  readonly prefixLength: number;
  readonly states: readonly StateRow[];
}

export interface HistoryRecord {
  readonly type: 'history';
  readonly rir: Rir;
  readonly query: string;
  readonly rawRecords: number;
  readonly latestFrom?: string;
  readonly objects: readonly ObjectHistory[];
}

export interface Change {
  readonly date: string;
  readonly kind: 'created' | 'withdrawn' | 're-created' | 'changed';
  readonly fields: StateSummary;
}

export const SUMMARY_FIELDS: readonly Field[] = ['name', 'status', 'country', 'type', 'nameservers', 'holder', 'holderName'];
export const FULL_FIELDS: readonly Field[] = [...SUMMARY_FIELDS, 'abuse', 'tech', 'admin'];

const dateOnly = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;

const partyKey = (p: Party | undefined): string | undefined => (!p ? undefined : isPersonal(p) ? 'personal' : p.handle);

/** A record with none of these is a withdrawal marker (it keeps only handle/range). */
function isTombstone(c: Obj): boolean {
  return c.name === undefined && c.status === undefined && c.vcardArray === undefined && c.nameservers === undefined;
}

function summarise(c: Obj): StateSummary | null {
  if (isTombstone(c)) return null;
  const ents = flattenEntities(c);
  const holder = partyFor(ents, 'registrant');
  const isEntity = c.objectClassName === 'entity';
  const ns = Array.isArray(c.nameservers)
    ? c.nameservers.flatMap((n) => { const x = clean(asObject(n).ldhName, 253); return x ? [x.toLowerCase().replace(/\.$/, '')] : []; })
    : [];
  const s: Partial<Record<Field, string>> = {
    name: isEntity ? (isPersonLike(c) ? undefined : clean(vcardValue(c, 'fn'))) : clean(c.name),
    status: strings(c.status).join(', ') || undefined,
    country: clean(c.country, 3),
    type: clean(c.type, 40),
    nameservers: ns.join(', ') || undefined,
    holder: partyKey(holder),
    holderName: holder && !isPersonal(holder) ? holder.name : undefined,
    abuse: partyKey(partyFor(ents, 'abuse')),
    tech: partyKey(partyFor(ents, 'technical')),
    admin: partyKey(partyFor(ents, 'administrative')),
  };
  for (const k of Object.keys(s) as Field[]) if (s[k] === undefined) delete s[k];
  return s;
}

function keyOf(c: Obj): { key: string; prefixLength: number } | null {
  if (c.objectClassName === 'ip network') {
    const prefixes = prefixesOf(c);
    const first = prefixes[0];
    return first ? { key: prefixes.join(' '), prefixLength: parseIpOrCidr(first).length } : null;
  }
  if (c.objectClassName === 'autnum' && typeof c.startAutnum === 'number') {
    const end = typeof c.endAutnum === 'number' && c.endAutnum !== c.startAutnum ? `-AS${c.endAutnum}` : '';
    return { key: `AS${c.startAutnum}${end}`, prefixLength: -1 };
  }
  if (c.objectClassName === 'domain' && typeof c.ldhName === 'string') {
    return { key: c.ldhName.toLowerCase().replace(/\.$/, ''), prefixLength: -1 };
  }
  const handle = clean(c.handle, 64);
  return handle ? { key: handle, prefixLength: -1 } : null;
}

function same(a: StateSummary | null, b: StateSummary | null, fields: readonly Field[] = FULL_FIELDS): boolean {
  if (a === null || b === null) return a === b;
  return fields.every((f) => a[f] === b[f]);
}

export function reduceHistory(raw: unknown, ctx: { rir: Rir; query: string }): HistoryRecord {
  const o = asObject(raw);
  if (!Array.isArray(o.records)) throw new RdapError('bad_response', 'History response has no records array');
  const groups = new Map<string, { prefixLength: number; rows: Array<StateRow & { ts: string }> }>();
  for (const item of o.records) {
    const r = asObject(item);
    const c = asObject(r.content);
    const from = dateOnly(r.applicableFrom);
    const k = keyOf(c);
    if (!from || !k || typeof r.applicableFrom !== 'string') continue;
    const g = groups.get(k.key) ?? { prefixLength: k.prefixLength, rows: [] };
    g.rows.push({ ts: r.applicableFrom, from, until: dateOnly(r.applicableUntil), s: summarise(c) });
    groups.set(k.key, g);
  }
  const objects: ObjectHistory[] = [...groups.entries()]
    .map(([key, g]) => {
      const sorted = g.rows.sort((a, b) => a.ts.localeCompare(b.ts));
      const states: StateRow[] = [];
      for (const { from, until, s } of sorted) {
        const last = states.at(-1);
        if (last && same(last.s, s)) states[states.length - 1] = { ...last, until };
        else states.push({ from, until, s });
      }
      return { key, prefixLength: g.prefixLength, states };
    })
    .sort((a, b) => b.prefixLength - a.prefixLength);
  const latestFrom = objects.flatMap((x) => x.states.map((s) => s.from)).sort().at(-1);
  return { type: 'history', rir: ctx.rir, query: ctx.query, rawRecords: o.records.length, latestFrom, objects };
}

function pick(s: StateSummary, fields: readonly Field[]): StateSummary {
  const out: Partial<Record<Field, string>> = {};
  for (const f of fields) if (s[f] !== undefined) out[f] = s[f];
  return out;
}

function diff(prev: StateSummary, cur: StateSummary, fields: readonly Field[]): StateSummary {
  const out: Partial<Record<Field, string>> = {};
  for (const f of fields) if (prev[f] !== cur[f]) out[f] = cur[f] ?? '(none)';
  return out;
}

export function historyChanges(obj: ObjectHistory, detail: Detail, since?: string): Change[] {
  const fields = detail === 'full' ? FULL_FIELDS : SUMMARY_FIELDS;
  const out: Change[] = [];
  let prev: StateSummary | null | undefined;
  let alive = false;
  let everAlive = false;
  for (const row of obj.states) {
    const cur = row.s ? pick(row.s, fields) : null;
    if (prev !== undefined && same(prev, cur, fields)) continue;
    if (cur === null) {
      if (alive) out.push({ date: row.from, kind: 'withdrawn', fields: {} });
      alive = false;
    } else if (!alive || prev == null) {
      out.push({ date: row.from, kind: everAlive ? 're-created' : 'created', fields: cur });
      alive = true;
      everAlive = true;
    } else {
      out.push({ date: row.from, kind: 'changed', fields: diff(prev, cur, fields) });
    }
    prev = cur;
  }
  return since ? out.filter((c) => c.date >= since) : out;
}

/** The registration state on a date: the most specific object first, then covering objects. */
export function stateAt(rec: HistoryRecord, date: string): { object: ObjectHistory; row: StateRow } | null {
  for (const object of rec.objects) {
    const row = object.states.find((r) => r.from <= date && (r.until === undefined || date < r.until));
    if (row) return { object, row };
  }
  return null;
}
