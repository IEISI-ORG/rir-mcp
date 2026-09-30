# Bibliography

Sources behind the rir-mcp design. Every entry was fetched and checked on **2026-09-30**: the URL resolved, metadata matched, and the specific claim we rely on was found in the source text (quoted). Entries are cited in the spec as `[ID]`.

Status key: **✓ verified** (claim found in source) · **◐ partial** (source verified, claim needs confirmation or is dated) · **✗ unverified** (source unreachable; not relied on).

## Standards (IETF RFCs)

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| RFC7480 | Newton, A., Ellacott, B., Kong, N. *HTTP Usage in the Registration Data Access Protocol (RDAP)*. RFC 7480, March 2015. https://www.rfc-editor.org/rfc/rfc7480 | "a server declines to answer a query due to rate limits, it returns a 429 (Too Many Requests) response code" | ✓ |
| RFC9082 | Hollenbeck, S., Newton, A. *RDAP Query Format*. RFC 9082, June 2021. https://www.rfc-editor.org/rfc/rfc9082 | Query paths `/ip`, `/autnum`, `/entity`, `/domain` | ✓ |
| RFC9083 | Hollenbeck, S., Newton, A. *JSON Responses for RDAP*. RFC 9083, June 2021. https://www.rfc-editor.org/rfc/rfc9083 | "rdapConformance" array identifies extensions in a response | ✓ |
| RFC9224 | Blanchet, M. *Finding the Authoritative RDAP Service*. RFC 9224, March 2022 (obsoletes RFC 7484). https://www.rfc-editor.org/rfc/rfc9224 | IANA bootstrap files route queries to the authoritative RIR | ✓ |
| RFC7095 | Kewisch, P. *jCard: The JSON Format for vCard*. RFC 7095, January 2014. https://www.rfc-editor.org/rfc/rfc7095 | Entity contact data format in RDAP | ✓ |
| RFC6350 | Perreault, S. *vCard Format Specification*. RFC 6350, August 2011. https://www.rfc-editor.org/rfc/rfc6350 | `KIND` property (`individual`, `group`, `org`) used by the PII filter | ✓ |
| RFC1918 | Rekhter, Y., et al. *Address Allocation for Private Internets*. RFC 1918 / BCP 5, February 1996. https://www.rfc-editor.org/rfc/rfc1918 | 10/8, 172.16/12, 192.168/16 private space | ✓ |
| RFC5737 | Arkko, J., Cotton, M., Vegoda, L. *IPv4 Address Blocks Reserved for Documentation*. RFC 5737, January 2010. https://www.rfc-editor.org/rfc/rfc5737 | "203.0.113.0/24 (TEST-NET-3) are provided for use in documentation" | ✓ |
| RFC6598 | Weil, J., et al. *IANA-Reserved IPv4 Prefix for Shared Address Space*. RFC 6598, April 2012. https://www.rfc-editor.org/rfc/rfc6598 | "Shared Address Space … 100.64.0.0/10" | ✓ |
| RFC5398 | Huston, G. *AS Number Reservation for Documentation Use*. RFC 5398, December 2008. https://www.rfc-editor.org/rfc/rfc5398 | Documentation ASNs 64496–64511 | ✓ |
| RFC6996 | Mitchell, J. *Autonomous System (AS) Reservation for Private Use*. RFC 6996, July 2013. https://www.rfc-editor.org/rfc/rfc6996 | Private ASNs "64512 - 65534" and "4200000000 - 4294967294" | ✓ |
| RFC7300 | Haas, J., Mitchell, J. *Reservation of Last Autonomous System (AS) Numbers*. RFC 7300, July 2014. https://www.rfc-editor.org/rfc/rfc7300 | AS 65535 reserved | ✓ |

## RDAP extensions and drafts

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| CIDR0 | NRO Engineering Coordination Group. *NRO RDAP CIDR extension (cidr0)*. https://bitbucket.org/nroecg/nro-rdap-cidr/src/master/nro-rdap-cidr.txt | `"cidr0_cidrs" : [ { "v4prefix", "length" } … ]` | ✓ |
| HISTDRAFT | Ellacott, B., et al. *Historical RDAP* (draft-ellacott-historical-rdap-00), IETF Internet-Draft, expired. https://datatracker.ietf.org/doc/html/draft-ellacott-historical-rdap-00 | Records carry `applicableFrom`/`applicableUntil`. **Discrepancy:** draft requires conformance string `"history_0"`; APNIC returns `"history_version_0"` [PROBE-APNIC]. The reducer keys on the live string. | ◐ |
| IANA-EXT | IANA. *RDAP Extensions registry*. https://www.iana.org/assignments/rdap-extensions/ | `cidr0` and `nro_rdap_profile_0` registered. **APNIC's history extension is not registered.** | ✓ |

## IANA registries and data

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| IANA-BOOT | IANA. *RDAP bootstrap files* (`ipv4.json`, `ipv6.json`, `asn.json`). https://data.iana.org/rdap/ | Maps ranges to RIR base URLs; ARIN and AFRINIC listed with both `https://` and `http://` bases | ✓ |
| IANA-SP4 | IANA. *IPv4 Special-Purpose Address Registry*. https://www.iana.org/assignments/iana-ipv4-special-registry/ | Source for the local special-use table | ✓ |
| IANA-SP6 | IANA. *IPv6 Special-Purpose Address Registry*. https://www.iana.org/assignments/iana-ipv6-special-registry/ | e.g. `2001:db8::/32` Documentation | ✓ |
| IANA-SPASN | IANA. *Special-Purpose AS Numbers Registry*. https://www.iana.org/assignments/iana-as-numbers-special-registry/ | Documentation and private-use ASN blocks | ✓ |

## RIR documents

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| PROP173 | Brewer, J. *prop-173-v001: Copyright and Acceptable Use Terms for APNIC Directory Services*. APNIC policy proposal, August 2026. https://www.apnic.net/wp-content/uploads/2026/08/prop-173-v001.txt | "APNIC may establish and enforce reasonable query-volume, rate, concurrency, and result-size limits" — **proposal, not adopted policy** | ✓ |
| APNIC-DBTERMS | APNIC. *APNIC WHOIS database copyright statement* (linked as `terms-of-service` from every APNIC RDAP response). http://www.apnic.net/db/dbcopyright.html | "Any use of this material to target advertising or similar activities is explicitly forbidden and will be prosecuted" — supports the ToU | ✓ |
| APNIC-TRLOG | APNIC. *Resource Transfer Log* and README (v1.1, 28 March 2013). https://ftp.apnic.net/transfers/apnic/ | Pipe-delimited daily log; "only records information that is accurate at the time the transfer happened" (deferred to v2) | ✓ |
| APNIC-STATS | APNIC. *WHOIS/RDAP query statistics README*. https://ftp.apnic.net/apnic/whois-rdap-stats/README.TXT | APNIC publishes hourly "aggregate statistics by origin ASN" — our traffic is visible to APNIC | ✓ |
| APNIC-WHOWAS | APNIC Blog. *whowas: queries for historical registration data*, 27 July 2017. https://blog.apnic.net/2017/07/27/whowas-queries-historical-registration-data/ | Background on APNIC whowas. (Earliest-record date is taken from [PROBE-APNIC], not this post.) | ✓ |
| LACNIC-RDAP | Formoso, A. *LACNIC's RDAP Service*. GTER 41, Uberlândia, **May 2016**. https://ftp.registro.br/pub/gter/gter41/07-RDAP-LACNIC.pdf | "Defaults to 2 rate limits: 10 per minute and 1000 per hour, whichever is violated first … IP-based" — **10 years old; confirm with LACNIC** | ◐ |
| AFRINIC-LIMIT | AFRINIC. *Daily whois query limit* (FAQ). https://afrinic.net/support/whois/faq/daily-whois-query-limit | Reported (via search summary) as 5,000 person-object queries/day per IP. **URL returns 404 (also blog.afrinic.net).** Not used in design. | ✗ |

## Model Context Protocol

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| MCP-TOOLS | MCP Specification, revision **2026-07-28** (current), *Server: Tools*. https://modelcontextprotocol.io/specification/2026-07-28/server/tools | `structuredContent`, optional `outputSchema`, `isError`; "a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block" (see spec §4 deviation note) | ✓ |
| MCP-HTTP | MCP Specification 2026-07-28, *Streamable HTTP*. https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http | "Servers MUST validate the `Origin` header … respond with HTTP 403"; "SHOULD bind only to localhost (127.0.0.1)"; "SHOULD implement proper authentication" | ✓ |
| MCP-DISCOVER | MCP Specification 2026-07-28, *Discovery*. https://modelcontextprotocol.io/specification/2026-07-28/server/discover | Servers MUST implement `server/discover`; `instructions` = "Optional natural-language guidance for LLMs" | ✓ |
| MCP-CHANGES | MCP Specification 2026-07-28, *Key Changes*. https://modelcontextprotocol.io/specification/2026-07-28/changelog | Sessions and `Mcp-Session-Id` removed; stateless (no `initialize`); `tools/list` SHOULD be deterministic; list results carry `ttlMs`/`cacheScope` | ✓ |
| MCP-SDK | `@modelcontextprotocol/server` / `core` / `client` 2.2.0 (npm, 2026-09-28); `@modelcontextprotocol/sdk` 1.31.0. https://github.com/modelcontextprotocol/typescript-sdk | Both declare `LATEST_PROTOCOL_VERSION = '2025-11-25'`; v2 `core` already contains 2026-07-28 schemas (`server/discover`) | ✓ |

## Licensing and law

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| CC-FAQ | Creative Commons. *Frequently Asked Questions*. https://creativecommons.org/faq/ | "We recommend against using Creative Commons licenses for software." | ✓ |
| POLYFORM-NC | PolyForm Project. *PolyForm Noncommercial License 1.0.0*. https://polyformproject.org/licenses/noncommercial/1.0.0 | Permits personal uses and use by "any charitable organization, educational institution, public research organization, …" — reason it was rejected (excludes commercial members) | ✓ |
| RAIL-NAMING | Responsible AI Licenses. *From RAIL to Open RAIL: Topologies of RAIL Licenses*, 18 Aug 2022. https://www.licenses.ai/blog/2022/8/18/naming-convention-of-responsible-ai-licenses | "RAIL-S: RAIL License includes Use Restrictions only applied to the source code" | ✓ |
| RAIL-GEN | Responsible AI Licenses. *Announcing the RAIL License Generator*, 19 Mar 2024. https://www.licenses.ai/blog/2024/3/19/announcing-the-rail-license-generator | Tool used to generate the licence text | ✓ |
| HF-OPENRAIL | Hugging Face. *OpenRAIL: Towards open and responsible AI licensing frameworks*. https://huggingface.co/blog/open_rail | Background on behavioural-use restrictions | ✓ |
| SPAM-ACT-AU | Commonwealth of Australia. *Spam Act 2003*. https://www.legislation.gov.au/C2004A01214/latest/text | Includes "Part 3—Rules about address-harvesting software and harvested-address lists" | ✓ |
| CAN-SPAM | 15 U.S.C. ch. 103, *Controlling the Assault of Non-Solicited Pornography and Marketing* (CAN-SPAM Act). https://www.law.cornell.edu/uscode/text/15/chapter-103 ; FTC compliance guide: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business | US anti-spam law cited in ToU | ✓ |

## Cloudflare platform

| ID | Reference | Claim relied on | Status |
|---|---|---|---|
| CF-KV | Cloudflare Docs. *How KV works*. https://developers.cloudflare.com/kv/concepts/how-kv-works/ | "Changes may take up to 60 seconds or more to be visible in other global network locations" — key revocation latency | ✓ |
| CF-DO-SQL | Cloudflare Docs. *SQLite-backed Durable Object Storage*. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ | `StateDO` storage | ✓ |
| CF-VITEST | Cloudflare Docs. *Vitest integration*. https://developers.cloudflare.com/workers/testing/vitest-integration/ | Current integration is the **Vitest plugin**; `@cloudflare/vitest-pool-workers` users are directed to "Migrate to Vitest plugin" | ✓ |

## Primary evidence (live probes, 2026-09-30)

Commands and outputs are in the design session; re-run with `pnpm test:live` once implemented.

| ID | Probe | Finding |
|---|---|---|
| PROBE-APNIC | `GET rdap.apnic.net/ip/1.1.1.1`, `/autnum/4608`, `/domain/1.1.1.in-addr.arpa`, `/ip/203.0.113.5` | 3,854 B IP response; no `Cache-Control`/`Retry-After`; `server: cloudflare`; conformance incl. `history_version_0`, `cidr0`; TEST-NET → 404 |
| PROBE-HIST | `GET rdap.apnic.net/history/{ip,autnum,entity,domain}/…` | 169 KB / 55 records for 1.1.1.0/24; 28 `individual` entities; collapses to 15 states; earliest record 2008-09-04 |
| PROBE-RIRS | One IP lookup each at ARIN, RIPE NCC, LACNIC, AFRINIC | All `cidr0`; RIPE/LACNIC/AFRINIC include `individual` vCards; latency 1.1–2.4 s; ARIN history 404, RIPE history 400 |
| PROBE-TRLOG | `GET ftp.apnic.net/transfers/apnic/transfer-apnic-latest` | 1.59 MB, 13,431 rows (11,084 IPv4, 2,346 ASN, 2,711 inter-RIR) |
| PROBE-NPM | `registry.npmjs.org/-/org/ieisi/package` | 404 — npm org `ieisi` does not exist yet |

## Consulted, not relied on

| ID | Reference | Note |
|---|---|---|
| BTW-MEDIA | *The registry API rate limit as a market barrier*. btw.media. https://btw.media/en/the-registry-api-rate-limit-as-a-market-barrier | Commentary; restates RFC 7480. Cite RFC7480 instead. |
