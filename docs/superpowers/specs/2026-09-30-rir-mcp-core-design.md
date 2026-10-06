# rir-mcp v1 — Core + RDAP Design

- **Date:** 2026-09-30
- **Repo:** `github.com/IEISI-ORG/rir-mcp` (public)
- **Status:** Draft for review
- **Sources:** [`docs/BIBLIOGRAPHY.md`](../../BIBLIOGRAPHY.md); citations appear as `[ID]`.
- **Scope:** Sub-project 1 of 4 (Core + RDAP). Later sub-projects: transfer-log datasets, routing/peering sources (PeeringDB, RIPE RIS/RIPEstat, bgp.tools), Slack front end.

## 1. Purpose

An MCP server that answers routine registry questions about IP addresses, prefixes, ASNs, organisations, reverse DNS delegations and registration history, for APNIC members and the wider operator community. Example channel: a Slack bot answering "Who holds 1.1.1.1?", "Who do I report abuse from AS4608 to?", "What's the history of 1.1.1.1?".

### Success criteria

1. Five tools answer current-state and history questions for all five RIRs (history: APNIC only).
2. A current-record answer renders in < 600 bytes; a history summary in < 1,500 bytes (vs 4–250 KB raw).
3. No personal data is returned, cached, logged, or committed to the repo.
4. Upstream load is bounded per RIR by a global limiter, independent of the number of users.
5. The same core runs as local stdio, local/self-hosted HTTP (Node), and Cloudflare Workers.

### Non-goals (v1)

- Search, wildcard, or batch queries (anti-harvesting; see §7).
- Live DNS resolution (RDAP delegation data only).
- Transfer-log provenance (deferred, §11).
- OAuth / MyAPNIC login.
- Redis backend for multi-instance Node (added when a deployment needs it).

## 2. Evidence gathered (2026-09-30)

| Fact | Source |
|---|---|
| APNIC publishes no RDAP rate limit; prop-173 (proposal, Aug 2026) would let APNIC enforce "query-volume, rate, concurrency, and result-size limits" | [PROP173] |
| No `Cache-Control`/`Retry-After` headers from APNIC RDAP; served via Cloudflare with bot cookies | [PROBE-APNIC] |
| All 5 RIRs support `cidr0` | [PROBE-RIRS], [CIDR0] |
| RIPE, LACNIC, AFRINIC return `individual` vCards in current records; APNIC and ARIN did not in the sampled record | [PROBE-RIRS] |
| Only APNIC serves RDAP history; ARIN → 404, RIPE → 400. APNIC's string is `history_version_0`, not the draft's `history_0`, and is not IANA-registered | [PROBE-HIST], [PROBE-RIRS], [HISTDRAFT], [IANA-EXT] |
| APNIC history: `1.1.1.0/24` = 169 KB, 55 records, 28 `individual` entities, collapses to 15 distinct reduced states | [PROBE-HIST] |
| IP history mixes covering objects (`0.0.0.0/0`, `1.0.0.0/8`) and deletion markers (empty content) | [PROBE-HIST] |
| IANA bootstrap lists both `http://` and `https://` bases for ARIN/AFRINIC | [IANA-BOOT] |
| LACNIC RDAP: 10 queries/min and 1,000/hour per IP (**confirm with LACNIC**; source is a May 2016 presentation) | [LACNIC-RDAP] |
| APNIC transfer log is structured pipe-delimited text, 13,431 rows (2,711 inter-RIR), daily | [PROBE-TRLOG], [APNIC-TRLOG] |
| APNIC's database terms forbid "use of this material to target advertising or similar activities" | [APNIC-DBTERMS] |
| MCP current revision is 2026-07-28 (stateless; no sessions; `server/discover` required); TypeScript SDK 2.2.0 negotiates 2025-11-25 but ships 2026-07-28 schemas | [MCP-CHANGES], [MCP-DISCOVER], [MCP-SDK] |
| MCP: a tool returning `structuredContent` "SHOULD also return the serialized JSON in a TextContent block" | [MCP-TOOLS] |
| Streamable HTTP: servers MUST validate `Origin` (403 if invalid), SHOULD bind to 127.0.0.1 locally | [MCP-HTTP] |
| Cloudflare KV changes "may take up to 60 seconds or more" to reach other locations | [CF-KV] |

## 3. Architecture

pnpm monorepo, TypeScript, three packages:

- **`@ieisi/rir-mcp-core`**: tools, input parsing, special-use registry, bootstrap router, RDAP client, reducers, renderer, port interfaces. Uses only `fetch` and Web APIs; no Node or Workers imports.
- **`@ieisi/rir-mcp-node`**: stdio and Streamable HTTP entry points; in-memory backends.
- **`@ieisi/rir-mcp-worker`**: Cloudflare Worker; one Durable Object (`StateDO`, SQLite storage) for cache, limiter, quotas, scan detector; secret or KV for auth. *(Amended 2026-10-04, Q9:)* the edge Worker does the path, Host, Origin and key checks, then makes one RPC to `StateDO`, which runs the MCP handler itself over its SQLite state. One round trip per request instead of one per cache, limiter and quota step.

```
packages/
  core/src/
    ports.ts          CacheStore, RateLimiter, KeyStore, Clock
    server.ts         createServer(deps) -> McpServer
    input/            parse-ip.ts, parse-asn.ts, parse-handle.ts, reverse-zone.ts
    special-use/      tables.ts (bundled IANA special-purpose data), lookup.ts
    rdap/             bootstrap.ts, client.ts, errors.ts, limits.ts (per-RIR profiles)
    reduce/           network.ts, autnum.ts, entity.ts, domain.ts, history.ts,
                      pii-filter.ts, sanitize.ts
    render/           text.ts
    tools/            ip.ts, asn.ts, entity.ts, reverse-dns.ts, history.ts
    guide/            instructions.ts, usage.md
  node/src/           stdio.ts, http.ts, memory-cache.ts, memory-limiter.ts, config.ts
  worker/src/         index.ts, state-do.ts, auth.ts, wrangler.jsonc
fixtures/rdap/<rir>/<kind>/<case>.json
scripts/              fixtures-record.ts, keys.ts
docs/                 guide, deployment (local, Docker, Cloudflare), specs
LICENSE TERMS_OF_USE.md SECURITY.md CONTRIBUTING.md README.md
```

Files stay under 400 lines. `tools/*` only wire input → pipeline → render.

### MCP protocol target

- SDK: TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/core`), not the v1 `@modelcontextprotocol/sdk` package [MCP-SDK].
- Negotiated protocol: 2025-11-25 (SDK default today). Design is already compatible with 2026-07-28 [MCP-CHANGES]: no per-connection state, no server-initiated requests, `tools/list` in fixed order, `instructions` available via `server/discover` [MCP-DISCOVER]. Adopt 2026-07-28 when the SDK makes it the default.
- No session state anywhere: the Worker needs no Durable Object for sessions; `StateDO` holds only cache, limiter and counters.

## 4. Tool surface

| Tool | Input | Upstream |
|---|---|---|
| `rdap_ip_lookup` | one IPv4/IPv6 address or CIDR | `/ip/{x}` |
| `rdap_asn_lookup` | `AS4608` or `4608` | `/autnum/{n}` |
| `rdap_entity_lookup` | handle, `^[A-Z0-9][A-Z0-9-]{0,63}$` (case-insensitive, upper-cased) + optional `rir` (inferred from suffixes `-AP`, `-ARIN`, `-RIPE`, `-LACNIC`, `-AFRINIC`; required otherwise, e.g. `IRT-APNICRANDNET-AU`) | `/entity/{h}` |
| `rdap_reverse_dns` | address or prefix; tool derives the zone | `/domain/{zone}`, walking to shorter zones on 404 (v4: /24 → /16 → /8; v6: nibble boundaries) |
| `rdap_history` | same inputs as above + `at?` (ISO date), `since?` (ISO date), `detail` = `summary` \| `full` | `/history/{type}/{x}` (APNIC only) |

### Output

Each result returns:
- a **text block**: aligned `key  value` lines (the model reads this);
- **`structuredContent`** conforming to a declared `outputSchema` (programmatic clients).

**Deliberate deviation from a SHOULD:** the MCP spec says a tool returning `structuredContent` SHOULD also return the *serialized JSON* in a TextContent block [MCP-TOOLS]. We return a purpose-built text rendering instead, because the text block is what most clients place in the model's context and the token budget (§1 criterion 2) is a core requirement. The same data is still fully available in `structuredContent`. Revisit if a target client turns out to rely on JSON in the text block.

Example, `rdap_ip_lookup("1.1.1.1")`:
```
network   1.1.1.0/24  APNIC-LABS  (AU, ASSIGNED PORTABLE, active)
holder    APNIC Research and Development  [ORG-ARAD1-AP]
abuse     helpdesk@apnic.net  [IRT-APNICRANDNET-AU]
tech      research@apnic.net  [AIC3-AP]
dates     registered 2011-08-10, changed 2023-04-26
source    APNIC RDAP, cached 0s
```

Example, `rdap_history("1.1.1.1")` (summary):
```
1.1.1.0/24  history (APNIC RDAP, 55 records -> 5 changes)
2010-01-22  created    Debogon-prefix  ASSIGNED PORTABLE  AU
2011-08-09  withdrawn
2011-08-10  re-created Debogon-prefix
2014-05-07  renamed    APNIC-LABS
2017-08-29  holder     ORG-ARAD1-AP (APNIC Research and Development)
covering: 1.0.0.0/8 APNIC-AP (since 2010-01-20)
```

`at` returns the single reduced record applicable on that date. For non-APNIC resources, `rdap_history` returns "Registration history is not published via RDAP by <RIR>."

### Field rules

- `abuse` = entity with role `abuse`; fall back to the holder's email only if none.
- Entities of vCard `kind: individual` [RFC6350] (carried as jCard [RFC7095]) are dropped. If the holder is an individual: `holder  private individual (not disclosed)`. `rdap_entity_lookup` on an individual handle returns "Personal record; not disclosed by this service."
- `remarks`, `notices`, `links` are never returned.
- Prefixes come from `cidr0_cidrs` [CIDR0]; fall back to range→CIDR computation when absent.

### Answers without upstream calls

Inputs in IANA special-purpose registries [IANA-SP4] [IANA-SP6] [IANA-SPASN] (RFC 1918 [RFC1918], RFC 5737 documentation [RFC5737], RFC 6598 [RFC6598], documentation ASNs [RFC5398], private-use ASNs 64512–65534 and 4200000000–4294967294 [RFC6996], AS 65535 [RFC7300], etc.) are answered locally, e.g. "Documentation space (RFC 5737); not allocated to any organisation."

## 5. Request pipeline

```
1  validate + canonicalise   zod; AS04608 -> 4608; 1.1.1.1/24 -> 1.1.1.0/24
2  special-use check         local answer, stop
3  cache get                 exact canonical key; fresh -> return
4  caller quota              hosted only; per clientId; sliding hourly window (amended 2026-10-04, audit #5)
5  global limiter            per-RIR bucket; weight 1 (current) / 5 (history)
6  route                     IANA bootstrap [RFC9224] [IANA-BOOT] -> https base URL only
7  fetch                     10 s timeout; User-Agent; Accept: application/rdap+json;
                             size cap 2 MB (current) / 5 MB (history);
                             at most 1 redirect, only to bootstrap-listed hosts
8  reduce                    flatten; drop individual/remarks/notices/links; sanitise
9  cache put                 reduced record only
10 render                    text + structuredContent
```

- **Coalescing:** concurrent requests for the same cache key share one upstream fetch.
- **User-Agent:** `rir-mcp/<version> (+https://github.com/IEISI-ORG/rir-mcp; operator=<contact>)`. `operator` is required config; the server refuses to start without it.
- **Sanitising:** strip control/bidi characters, cap free-text fields at 120 characters, never interpret registry text. *(Amended 2026-10-05:)* registry text is also defanged so no Markdown renderer can show it as a link, image, HTML, code, strikethrough or bold (no square/angle brackets, character references and backslashes neutralised, schemes, `//` and `www.` defanged, emphasis/strike/code markers neutralised, combining-mark stacks capped); `test/reduce/render-safety.test.ts` checks this against real renderers, including a seeded fuzz test. Residual: fuzzy linkifiers may link a bare domain, which shows its own target.

### Errors

Returned as tool results with `isError: true` and one actionable sentence.

| Condition | Response | Cache |
|---|---|---|
| Invalid input | Accepted forms, e.g. "use `AS4608` or `4608`" | — |
| Upstream 404 | "Not registered in <RIR>; may be unallocated." | negative, 15 min |
| Local quota/limiter exhausted | "Rate limit reached; retry in N s." (no upstream call) | — |
| Upstream 429 [RFC7480] | Penalise RIR bucket; serve stale if present | — |
| Upstream 5xx / timeout | Serve stale, labelled `stale (fetched 3h ago)`; else "<RIR> RDAP unavailable." | stale ≤ 24 h |
| Oversize | "Response too large." | — |

## 6. Cache and rate limiting

### Ports (core)

```ts
interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, entry: CacheEntry, opts: { ttlS: number; staleS: number }): Promise<void>;
}
interface RateLimiter {
  acquire(bucket: string, weight: number): Promise<{ ok: true } | { ok: false; retryAfterS: number }>;
  penalise(bucket: string): Promise<void>;
}
interface KeyStore {
  verify(presentedKey: string): Promise<{ clientId: string; quotaPerHour: number } | null>;
}
```

`CacheEntry` carries `fetchedAt`, so output can report age and staleness.

### Cache keys and TTLs

Keys are exact canonical queries (`ip:1.1.1.1`, `asn:4608`, `hist:ip:1.1.1.0/24`). No range reuse in v1: a cached covering prefix cannot prove that no more-specific object exists.

| Item | Fresh | Stale-on-error |
|---|---|---|
| Current record | 1 h | 24 h |
| Not found | 15 min | — |
| History (reduced) | 7 days, validated (below) | 30 days |
| IANA bootstrap | 24 h | 7 days |
| Special-use tables | bundled per release | — |

**History validation:** history is append-only; closed records never change. Before serving cached history, compare the newest `applicableFrom` date in it with the current record's `last changed` date (from cache, or a weight-1 fetch). `last changed` later than the newest history record → refetch history (weight 5); otherwise serve. (Equality is not the test: embedded contact changes also create history records, so the newest record is often *later* than `last changed` — e.g. 1.1.1.0/24: newest record 2025-11-18, `last changed` 2023-04-26 [PROBE-HIST].) To avoid refetch loops when APNIC's history lags, refetch at most once per `last changed` date.

### Per-RIR limit profiles

| RIR | Sustained | Burst | Extra ceiling |
|---|---|---|---|
| APNIC | 1/s | 5 | — |
| ARIN | 1/s | 5 | — |
| RIPE NCC | 1/s | 5 | — |
| AFRINIC | 1/s | 5 | — |
| LACNIC | 10/min | 3 | 1,000/hour |

On upstream 429 or 5xx the RIR's rate halves for 5 minutes, then restores. Profiles are config; the table above is the default and the maximum (code constants).

### Backends

| | Node | Worker |
|---|---|---|
| Cache | in-memory LRU, 10k entries and 50 MB of values (implemented in `core/src/memory/`: no runtime imports, so it lives in core and Node re-uses it) | `StateDO` SQLite |
| Limiter + quotas + scan counters | in-process | `StateDO` |
| Keys | `RIR_MCP_API_KEY` env, or keys file of SHA-256 hashes | secret or KV (§7) |

One Durable Object instance holds all shared state for a deployment (global consistency, no KV write limits) and serves every MCP request (Q9). Shard by RIR if it becomes a bottleneck. The Worker cache is bounded by entry count (10k) and total bytes (50 MB); state survives Durable Object eviction; scan-detector digests are kept for the current hour and purged within about an hour after it ends (by an alarm; Node by an hourly sweep).

## 7. Security, access, Terms of Use

### Authentication (hosted HTTP)

One scheme: `Authorization: Bearer <key>`. Two storage modes, chosen automatically (on Cloudflare: by `KEYS_MODE`, see below), **fail closed**:

| Mode | Cloudflare | Node | clientId |
|---|---|---|---|
| Key per user | KV namespace `API_KEYS`: `sha256(key)` → `{clientId, quotaPerHour, touVersion, revoked}` | keys file of the same records (`RIR_MCP_KEYS_FILE`), reloaded on change | from record |
| Single key | Worker secret `API_KEY` | `RIR_MCP_API_KEY` | `default` |
| Neither configured | reject all requests | refuse to start HTTP | — |

- Per-user mode takes precedence if both are configured. *(Amended 2026-10-04, Plan 3 Task 7: on Cloudflare, per-user mode is selected explicitly with `KEYS_MODE=kv`, because the KV binding is always declared and may be empty; an unknown `KEYS_MODE` is a configuration error. A missing or invalid setting answers 503 `not_configured` and logs `{"status":503,"reason":"not_configured","setting":"<name>"}` per request, in place of the planned `{"alert":"no_auth_configured"}`.)*
- Keys: `rirmcp_` + 32 random bytes base64url; only hashes stored (per-user mode). Comparison is constant-time.
- KV is eventually consistent: changes "may take up to 60 seconds or more" to reach other locations [CF-KV], so a revoked key can keep working briefly. Accepted: data is public and quotas still apply. ~~For urgent revocation, also add the key's hash to a deny-list in `StateDO` (strongly consistent).~~ *(Deferred 2026-10-04, Q10: no admin endpoint yet; revoke by deleting the KV record, effective within about 60 s.)*
- Revocation parity (decided 2026-10-03, QUESTIONS.md Q4): operators get one model on both runtimes ("edit the keys; effective in under a minute"). Node re-reads the keys file at most every 30 s and reloads when its contents change (not mtime: `cp -p`/`rsync -t` preserve it); if the file becomes unreadable or invalid, every key is rejected until it is fixed and one error is logged — fail closed at runtime as at startup, so a half-finished revocation never leaves old keys live. ~~Cloudflare checks the `StateDO` deny-list on the same per-request DO call the quota check already makes.~~ *(Q10: Cloudflare revocation is the KV delete above.)*
- `scripts/keys.ts create|revoke|list` manages KV records; a key is issued only after the client accepts the ToU (version recorded). *(As built 2026-10-04: `keys.ts new … --target kv` and `revoke <key|sha256> --target kv` print the `wrangler kv key put/delete` commands for the operator to run; no network calls. `list` is not built: `wrangler kv key list --binding API_KEYS` lists hashes. ToU version recording waits for Plan 4.)*
- Node HTTP binds to `127.0.0.1` by default; both HTTP entry points validate `Origin` and return 403 when it is present and invalid [MCP-HTTP]; public binding is an explicit option.
- stdio: no auth (local user is the operator).

### Anti-harvesting

- No search, wildcard, or batch tools; one resource per call.
- Per-client quota: 60 upstream calls/hour (cache hits free).
- Scan detector: per client, count distinct /24s (v4), /48s (v6), and ASNs queried per hour (counts only, never values). Above 200 → suspend client, alert operator.

### Logging

Logged: tool, RIR, cache outcome (hit/miss/stale), outcome code (e.g. `record`, `not_found`, `rate_limited`, `upstream`; amended 2026-10-04: the code, not the raw upstream HTTP status), latency, clientId. **Not logged:** query values, API keys, `Authorization` headers, registry payloads.

### Prompt-injection controls

Static tool descriptions; sanitised, length-capped registry text in fixed fields; no `remarks`/`notices`; only bootstrap-derived URLs in output.

### Supply chain

Lockfile, minimal runtime deps (`@modelcontextprotocol/server` v2, `zod`; IP parsing written in-repo unless a small audited library is preferable), Dependabot, CodeQL, secret scanning, npm provenance.

### Licence and terms

Intent: **any RIR member, commercial or not, may use, run, modify and redistribute rir-mcp without a separate licence. No one may use it to market to or harass RIR members.** The restriction is on conduct, not on who the user is.

- **Code:** OpenRAIL-S (source-code variant of the OpenRAIL behavioural-use licence family [RAIL-NAMING] [HF-OPENRAIL]), generated with the RAIL License Generator [RAIL-GEN]. Rejected: CC BY-NC-SA (CC advises against CC licences for software [CC-FAQ]) and PolyForm Noncommercial (excludes commercial RIR members [POLYFORM-NC]). Use, modification and distribution are otherwise unrestricted; derivatives must carry the same use restrictions, so they bind self-hosters and forks. Custom behavioural restrictions:
  1. No marketing, advertising, or unsolicited commercial communication directed at resource holders or their contacts using data obtained through the software.
  2. No harassment, intimidation, or targeting of RIR members or their staff.
  3. No harvesting, bulk extraction, or building contact/marketing lists from registry data.
  4. No circumvention of the software's rate limits, quotas, or scan detection, or of any RIR's access limits and terms.
- Not OSI "open source" (use restrictions); README says "source-available under OpenRAIL-S" and states the intent above in plain words.
- **Pre-release gate:** licence text reviewed by APNIC Legal Counsel before the repo is made public (§12).
- **`TERMS_OF_USE.md`:** governs hosted deployments; repeats restrictions 1–4, cites applicable anti-spam law (e.g. Spam Act 2003 (AU) [SPAM-ACT-AU], CAN-SPAM (US) [CAN-SPAM]) and each RIR's database terms (e.g. APNIC forbids use "to target advertising or similar activities" [APNIC-DBTERMS]). Breach → key revocation and legal action.
- Server `instructions` include a one-line ToU notice with the link.
- `SECURITY.md` (private vulnerability reporting), `CONTRIBUTING.md` (adding an RIR fixture; PII lint).

## 8. LLM guide

1. **Server `instructions`** (~150 words): scope, the five tools in one line each, one resource per call, no personal data, ToU link.
2. **Tool descriptions**, fixed template: *Answers* / *Input forms* / *Example questions* / *Does not*.
3. **Resource `guide://usage`**: worked examples; reused as the Slack bot's `/help`.

## 9. Testing

vitest; TDD for `core`.

| Layer | Tests |
|---|---|
| Input | Canonicalisation, rejection, reverse-zone derivation and walk-up |
| Special-use | Each bundled range/ASN block answered locally; no fetch called |
| Reducer | Golden JSON per RIR × object kind from fixtures |
| Renderer | Snapshots per record type |
| PII | Reduced output contains no `individual` data; **fixture lint**: every `individual` vCard in `fixtures/` uses only synthetic values (`example.*` domains, placeholder names) |
| Token budget | Rendered current < 600 bytes; history summary < 1,500 bytes, for every fixture |
| History | Grouping by object, collapse, `withdrawn`, `at`, `since`, validation logic |
| Limiter / cache | Token bucket, LACNIC dual window, penalise/restore, TTL/stale, coalescing, scan threshold (fake clock) |
| Auth | Mode selection incl. fail-closed; revoked key; constant-time compare |
| MCP contract | All 5 tools via SDK in-memory transport with fake `fetch` |
| Worker | `StateDO` via Cloudflare's Vitest plugin (successor to `@cloudflare/vitest-pool-workers`) [CF-VITEST] |
| Live drift | `pnpm test:live`: 1 query per RIR, weekly scheduled CI only |

`scripts/fixtures-record.ts` fetches a response, replaces values in `individual` vCards with synthetic values (structure preserved), and writes the fixture.

## 10. Deployment modes

| Mode | Command | Auth | State |
|---|---|---|---|
| Local stdio | `npx @ieisi/rir-mcp-node --stdio` | none | memory |
| Local/self-hosted HTTP | `npx @ieisi/rir-mcp-node --http` / Docker | single key or keys file | memory |
| Cloudflare | `wrangler deploy` | secret or KV | `StateDO` |

`operator` contact is required in all modes (User-Agent).

## 11. Deferred

- **Transfer-log provenance (v2):** APNIC `transfer-apnic-latest` (pipe-delimited, daily, org names only) indexed as an interval structure; introduces a `Dataset` abstraction that the bootstrap and special-use tables then adopt.
- Range-aware cache reuse (needs a leaf-object signal).
- Live DNS cross-check for reverse delegations (DoH).
- Redis backend; OAuth; other RIRs' history if they publish it.
- Sub-projects 3 (PeeringDB, RIS, bgp.tools) and 4 (Slack bot).

## 12. Open items to confirm during implementation

- LACNIC limits (10/min, 1,000/h) with LACNIC directly; the only source is from May 2016 [LACNIC-RDAP].
- Whether any other RIR publishes RDAP limits (none found 2026-09-30).
- npm org `ieisi` does not exist yet [PROBE-NPM]: create it under IEISI before first publish (else choose another scope).
- **TODO: ask APNIC Legal Counsel for their opinion** on the OpenRAIL-S custom restrictions and `TERMS_OF_USE.md`, including consistency with APNIC's database terms and prop-173 (blocks making the repo public, not development).
