/**
 * Records RDAP fixtures from the live RIRs, scrubbing personal data before writing.
 * Usage: RIR_MCP_OPERATOR='<operator contact>' corepack pnpm fixtures:record
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { buildUserAgent } from '../packages/core/src/rdap/user-agent';
import { scrubRdap } from '../packages/core/test/support/scrub';

// Node's 250 ms Happy Eyeballs default times out on high-latency RIRs (e.g. LACNIC, AFRINIC from Australia).
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['iana/ipv4.json', 'https://data.iana.org/rdap/ipv4.json'],
  ['iana/ipv6.json', 'https://data.iana.org/rdap/ipv6.json'],
  ['iana/asn.json', 'https://data.iana.org/rdap/asn.json'],
  ['rdap/apnic/ip/1.1.1.1.json', 'https://rdap.apnic.net/ip/1.1.1.1'],
  ['rdap/apnic/ip/2001_dc0__1.json', 'https://rdap.apnic.net/ip/2001:dc0::1'],
  ['rdap/apnic/autnum/4608.json', 'https://rdap.apnic.net/autnum/4608'],
  ['rdap/apnic/entity/ORG-ARAD1-AP.json', 'https://rdap.apnic.net/entity/ORG-ARAD1-AP'],
  ['rdap/apnic/domain/1.1.1.in-addr.arpa.json', 'https://rdap.apnic.net/domain/1.1.1.in-addr.arpa'],
  ['rdap/apnic/domain/0.c.d.0.1.0.0.2.ip6.arpa.json', 'https://rdap.apnic.net/domain/0.c.d.0.1.0.0.2.ip6.arpa'],
  ['rdap/apnic/history-ip/1.1.1.1.json', 'https://rdap.apnic.net/history/ip/1.1.1.1'],
  ['rdap/apnic/history-autnum/4608.json', 'https://rdap.apnic.net/history/autnum/4608'],
  ['rdap/arin/ip/8.8.8.8.json', 'https://rdap.arin.net/registry/ip/8.8.8.8'],
  ['rdap/arin/autnum/15169.json', 'https://rdap.arin.net/registry/autnum/15169'],
  ['rdap/ripe/ip/193.0.6.139.json', 'https://rdap.db.ripe.net/ip/193.0.6.139'],
  ['rdap/ripe/autnum/3333.json', 'https://rdap.db.ripe.net/autnum/3333'],
  ['rdap/lacnic/ip/200.3.14.10.json', 'https://rdap.lacnic.net/rdap/ip/200.3.14.10'],
  ['rdap/lacnic/autnum/28000.json', 'https://rdap.lacnic.net/rdap/autnum/28000'],
  ['rdap/afrinic/ip/196.216.2.1.json', 'https://rdap.afrinic.net/rdap/ip/196.216.2.1'],
  ['rdap/afrinic/autnum/33764.json', 'https://rdap.afrinic.net/rdap/autnum/33764'],
];

const userAgent = buildUserAgent(process.env.RIR_MCP_OPERATOR ?? '');

for (const [rel, url] of FIXTURES) {
  const res = await fetch(url, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': userAgent } });
  if (!res.ok) {
    console.error(`FAIL ${res.status} ${url}`);
    process.exitCode = 1;
    continue;
  }
  const raw: unknown = await res.json();
  const doc = rel.startsWith('rdap/') ? scrubRdap(raw) : raw;
  const path = join('fixtures', rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`ok   ${rel}`);
  await new Promise((resolve) => setTimeout(resolve, 1500)); // well under every RIR's limit
}
