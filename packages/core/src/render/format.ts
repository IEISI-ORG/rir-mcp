import { RIR_LABEL } from '../rdap/rirs';
import { isPersonal, type Party } from '../reduce/types';
import type { Meta } from '../service/answer';

/** Aligned "key  value" lines; rows with no value are dropped. */
export function lines(rows: ReadonlyArray<readonly [string, string | undefined]>): string {
  return rows
    .filter((r): r is readonly [string, string] => Boolean(r[1]))
    .map(([k, v]) => `${k.padEnd(Math.max(10, k.length + 1))}${v}`)
    .join('\n');
}

export function age(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function sourceText(meta: Meta): string {
  const label = RIR_LABEL[meta.rir];
  if (meta.cache === 'miss') return `${label} RDAP, fetched just now`;
  if (meta.cache === 'hit') return `${label} RDAP, cached ${age(meta.ageS)} ago`;
  return `${label} RDAP, STALE: fetched ${age(meta.ageS)} ago; could not refresh`;
}

export function datesText(registered?: string, changed?: string): string | undefined {
  const parts = [registered && `registered ${registered}`, changed && `changed ${changed}`].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function holderText(p: Party | undefined): string | undefined {
  if (!p) return undefined;
  if (isPersonal(p)) return 'private individual (not disclosed)';
  return `${p.name ?? p.handle}  [${p.handle}]`;
}

/** `pointer` (the record's RDAP URL) is shown for undisclosed abuse contacts so users can follow up. */
export function contactText(p: Party | undefined, pointer?: string): string | undefined {
  if (!p) return undefined;
  if (isPersonal(p)) return pointer ? `personal contact, not disclosed; see ${pointer}` : 'personal contact, not disclosed';
  return `${p.email ?? p.name ?? p.handle}  [${p.handle}]`;
}

export function details(...parts: ReadonlyArray<string | undefined>): string {
  const d = parts.filter(Boolean).join(', ');
  return d ? `  (${d})` : '';
}
