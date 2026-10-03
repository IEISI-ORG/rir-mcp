export const RIRS = ['apnic', 'arin', 'ripe', 'lacnic', 'afrinic'] as const;
export type Rir = (typeof RIRS)[number];

export const RIR_LABEL: Readonly<Record<Rir, string>> = {
  apnic: 'APNIC',
  arin: 'ARIN',
  ripe: 'RIPE NCC',
  lacnic: 'LACNIC',
  afrinic: 'AFRINIC',
};

/** RDAP hostnames as listed in the IANA bootstrap files. Look up with `rirForHost`, never by indexing. */
const RIR_HOSTS: Readonly<Record<string, Rir>> = {
  'rdap.apnic.net': 'apnic',
  'rdap.arin.net': 'arin',
  'rdap.db.ripe.net': 'ripe',
  'rdap.lacnic.net': 'lacnic',
  'rdap.afrinic.net': 'afrinic',
};

/** Own properties only: plain-object indexing would accept "constructor", "__proto__", "toString" as hosts. */
export function rirForHost(host: string): Rir | undefined {
  return Object.hasOwn(RIR_HOSTS, host) ? RIR_HOSTS[host] : undefined;
}
