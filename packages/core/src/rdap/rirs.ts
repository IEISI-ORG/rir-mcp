export const RIRS = ['apnic', 'arin', 'ripe', 'lacnic', 'afrinic'] as const;
export type Rir = (typeof RIRS)[number];

export const RIR_LABEL: Readonly<Record<Rir, string>> = {
  apnic: 'APNIC',
  arin: 'ARIN',
  ripe: 'RIPE NCC',
  lacnic: 'LACNIC',
  afrinic: 'AFRINIC',
};

/** RDAP hostnames as listed in the IANA bootstrap files. */
export const RIR_HOSTS: Readonly<Record<string, Rir>> = {
  'rdap.apnic.net': 'apnic',
  'rdap.arin.net': 'arin',
  'rdap.db.ripe.net': 'ripe',
  'rdap.lacnic.net': 'lacnic',
  'rdap.afrinic.net': 'afrinic',
};
