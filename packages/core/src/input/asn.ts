import { InputError } from './errors';

export const ASN_MAX = 4294967295;
const ASN_HINT = 'Use an AS number such as AS4608 or 4608 (asdot like 1.10 is also accepted).';

export function parseAsn(raw: string | number): number {
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 0 && raw <= ASN_MAX) return raw;
    throw new InputError(`AS number out of range: ${raw}`, ASN_HINT);
  }
  const s = raw.trim().replace(/^AS\s*/i, '');
  let n: number;
  const asdot = /^(\d{1,5})\.(\d{1,5})$/.exec(s);
  if (asdot) {
    const hi = Number(asdot[1]);
    const lo = Number(asdot[2]);
    if (hi > 65535 || lo > 65535) throw new InputError(`Invalid asdot AS number: "${raw}"`, ASN_HINT);
    n = hi * 65536 + lo;
  } else if (/^\d{1,10}$/.test(s)) {
    n = Number(s);
  } else {
    throw new InputError(`Not an AS number: "${raw}"`, ASN_HINT);
  }
  if (n > ASN_MAX) throw new InputError(`AS number out of range: "${raw}"`, ASN_HINT);
  return n;
}
