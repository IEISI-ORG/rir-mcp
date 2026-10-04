# rir-mcp Plan 1 — follow-ups

Deferred findings from the Plan 1 task reviews and the final whole-branch review (2026-09-30). None blocks Plan 1; the final reviewer triaged each as "can wait". Grouped by where they were found.

## Security hardening (do first)

- ~~Sanitiser: also strip variation selectors and blank fillers~~ — done 2026-10-03 (also U+FFA0 and lone surrogates).
- ~~Redirect allow-list ignores port and userinfo~~ — done 2026-10-03.
- ~~Non-ASCII handles upper-cased into ASCII (ß→SS, ı→I)~~ — done 2026-10-03; validated before upper-casing.
- ~~Reader lock not released on mid-read error~~ — done 2026-10-03.
- Already resolved on review 2026-10-03: raw invisible characters in tests are `\u` escapes; tag characters, U+061C, U+00AD, U+180E are Cf and stripped; input echoes are bounded by the tool schemas (`max(64)`/`max(20)`).
- Fixture PII lint: `PERSON_KEY` is a key-name heuristic — rescan the key inventory whenever fixtures are re-recorded or a new source is added; lint notice titles and `redacted` descriptions too.

## Daily security audit 2026-10-03 (snapshot 998bb8a) — deferred Lows

Fixed the same day: Medium #1 (history domain keys raw → `dnsName`), Medium #2 (deleted personal entity's history served → reducer marks `personal`, service refuses), Low #3 (redirect query/fragment/path → RDAP-path check), Low #6 (`SingleKeyStore` NaN quota → validated).

- **#4 Byte-bounded memory:** `MemoryCache` caps 10k *entries*, not bytes; unusual upstream data (synthetic 5.3 MB history → 3.1 MB reduced) could hold GBs. Also uncapped arrays in `at`-mode text, history `structuredContent.state`, network `structuredContent`. Fix: cap array counts in reducers (e.g. 64 prefixes/status/nameservers, 2,000 history rows) and `cap()` the `at` lines; consider a byte budget in the cache.
- **#5 Fixed hourly windows in `MemoryClientGate`:** 60 calls at 00:59 + 60 at 01:00; same for 200+200 scan units. RIR load still bounded by the per-RIR limiter. Fix: sliding window (two buckets with weighted carry-over). Revisit together with the StateDO gate in Plan 3 so both runtimes share the algorithm.
- **IANA bootstrap refetch before `charge`:** during an IANA outage, over-quota clients still trigger bootstrap refetches (routing runs before the quota check). Load goes to IANA, not RIRs. Fold into the existing "no negative caching during IANA outage" item (Task 6).

## Code review, iteration 5 (2026-10-04, Plan 2 Tasks 1–7) — deferred Minors

Fixed the same day: rDNS charged per zone, limiter refusal spent quota, NaN quota fail-open in the gate. Allow-list format validation is folded into Plan 2 Task 8.

- keys-file: log one "keys file reloaded" line when a broken file becomes valid again (operators cannot see recovery today).
- `scripts/keys.ts hash <key>` puts the key in shell history and `ps`; read it from stdin when the argument is `-` or absent.
- The `rir-mcp` bin only runs via tsx (extensionless imports; workspace core is TS source) — needs the Plan 4 build.
- Spec §7 lists "upstream status" as a logged field; `CallLog` logs the outcome code. Update the spec or add the field.
- Tests: no slow-body timeout test; the 413 test should assert the per-request server factory never ran (spy on `service.forClient`).
- EADDRINUSE at startup surfaces as an unhandled rejection rather than a clean `rir-mcp:` message.

## Plan 2 Task 8 — deferred

- ~~README: add the HTTP-mode one-liner~~ Done 2026-10-04 (iteration 8, `347d3b8`): README rewritten with an HTTP quick start.

## Code review, iteration 10 (2026-10-04, Plan 3 Tasks 1–5) — deferred Minors

Fixed in the iteration: unread upstream bodies are cancelled (`10b5234`); scan digests are dropped on suspension and purged by a DO alarm after their window (`26f3922`). The Task 7 requirements (validate `OPERATOR` via `buildUserAgent`, catch `serve` errors) are in the Plan 3 ledger.

- ~~**Before the first Worker deploy:**~~ Done 2026-10-04 (`5235d76`): running totals in memory, `bytes` before `value`, `schema_version` 1. Was: the `cache` table reads every row's `bytes` on each put (`count(*)`, `sum(bytes)`), and `bytes` sits after the large `value` column. Move `bytes` before `value` or keep running totals in `meta`. Also write a `schema_version` to `meta` now: `CREATE TABLE IF NOT EXISTS` cannot change an existing table.
- ~~Bootstrap re-reads~~ Done 2026-10-04 (`1ad0f45`): parsed index reused while fresh; 5-minute back-off after a failed refresh (also fixes the Task 6 "no negative caching during IANA outage" item). Still open: each record cache hit is a SQLite row write (`used_at`). Was: Each cache hit is a SQLite row write (`used_at`), and the IANA bootstrap row (~11.5 KB) is read and parsed 2–3 times per lookup. Skip recent recency updates, or keep the parsed bootstrap in memory keyed on `fetchedAt`.
- ~~Suspension and hourly-window eviction tests~~ Done 2026-10-04 (`0b2270c`). Still open:  `SqlCache` run through the `MemoryCache` cases; a history lookup through the DO.
- ~~`authInfo` is built in both `core/src/http/edge.ts` and `handler.ts`: extract `authInfoFor(client)`.~~ Done 2026-10-04 (`c3aa169`).
- ~~README says raw RDAP JSON is "4–250 KB"; the fixtures go up to 370 KB (history). Reword.~~ Done 2026-10-04.
- Task 8 docs: describe Worker persistence accurately (suspensions survive restarts; salted digests persist for up to an hour), and check whether Workers Logs records request headers such as `Authorization` before deploying.

## Plan 3 (Cloudflare Worker) — open items after Task 8

- Not yet run on a live Cloudflare account. First deploy: follow `docs/deployment.md` → Cloudflare Workers, then run one live lookup per RIR through the Worker. Do the iteration-10 "before the first Worker deploy" items first (cache column order, `schema_version`).
- `wrangler` sends anonymous usage telemetry by default; set `WRANGLER_SEND_METRICS=false` when running it here.
- Single-key Worker deployments have a fixed quota of 60/hour (no `QUOTA_PER_HOUR` var yet); per-user KV records set their own.
- Urgent revocation (StateDO deny-list, admin endpoint) deferred by Q10.

## Plan 3 final review (2026-10-04) — deferred Minors

Fixed at the review: kv mode without the KV binding now answers 503, and key-store failures log `auth_error` (`41fc1c3`); traces pinned off, docs corrected for browser clients, tail and retention, spec §7 amended (`8af70ce`).

- ~~Quota bound~~ Done 2026-10-04 (`e8af5cb`). Was: `scripts/keys.ts` and `parseKeyRecords` accept any positive integer quota, e.g. `1e+23` (effectively unlimited). Cap at 1,000,000 like `RIR_MCP_QUOTA_PER_HOUR`. `revoke` rejects an uppercase hex hash instead of lower-casing it.
- ~~Alarm arming~~ Done 2026-10-04. Was: `StateDO.serve`: if `getAlarm`/`setAlarm` throws after the handler finished, the answer is lost although the quota was charged. Wrap the arming in try/catch and log the type.
- ~~Allow-list case~~ Done 2026-10-04. Was: `ALLOWED_HOSTS` / `RIR_MCP_ALLOWED_HOSTS` are compared case-sensitively with the SDK's lower-cased hostname: an uppercase entry gives a permanent 403. Lower-case both lists when loading.
- ~~`.gitignore`: add `.wrangler/` and `.dev.vars.*`.~~ Done 2026-10-04.
- ~~Tests: KV `get` throwing through the Worker entry; 403 Host/Origin create no DO.~~ Done 2026-10-04.
- ~~Node idle scan hashes~~ Done 2026-10-04 (`1d428b2`, hourly `clearExpiredUnits`). Was: Node keeps an idle client's scan hashes in memory until its next request or a restart. Add a periodic sweep, for parity with the Worker's alarm.

## Parked at final review

- history names bootstrap RIR when the redirect-detecting current lookup fails (real, minor; the user still gets a correct refusal or can retry)
- sanitiser misses variation selectors U+FE00–FE0F / U+E0100–E01EF (Mn) and blank Lo fillers (U+3164, U+115F, U+1160, U+2800) (real, deferred to a follow-up hardening item (hidden-payload channel similar to tag chars; low likelihood in RIR data))
- ZWJ/ZWNJ become spaces (acceptable, not a regression)
- operator contact may end with backslash (RFC 9110 comment quoted-pair) (grammar-only, no injection)
- redirect test doesn't assert weight; scripts/fixtures-record.ts usage comment still says you@example.net (cosmetic, follow-up)

## Deferred minors by task

- **Task 1**: rangeToCidrs lacks IPv6/single-address/start>end tests; prefixContains lacks IPv6/equal cases.
- **Task 1**: `1.1.1.1/024` accepted as /24 (non-canonical length digits) — untested.
- **Task 2**: toUpperCase maps non-ASCII (ß→SS, ı→I) into valid handles; reject non-ASCII before upper-casing.
- **Task 2**: inferRirFromHandle expects parseHandle output (no normalisation/doc).
- **Task 2**: no tests for 64-char handle boundary, handle hint, IPv6 /30 /50 /96, IPv4 /24 /16 zones; `4608.0` parses as asdot silently; error messages echo raw input unbounded.
- **Task 3**: tests cover 10/27 IP rows; no table-driven drift guard; longest-prefix branch unexercised (no overlapping rows).
- **Task 4**: refill applies one rate across a span straddling penaltyUntil; no test for rate restoration after 5 min.
- **Task 4**: cost=min(weight,burst) undocumented/untested (LACNIC history would drain 3 not 5; history is APNIC-only so moot today).
- **Task 4**: hourly window is fixed not rolling (≤2× cap across boundary; unreachable for LACNIC at 10/min).
- **Task 4**: no clamp for backward clock step (fails safe); clampProfile accepts 0/negative/NaN; penalise ignores unknown bucket while acquire throws.
- **Task 4**: cache tests lack put-overwrite and expired-vs-capacity cases.
- **Task 5**: redirect allowlist ignores port/userinfo (SSRF hardening); buildUserAgent allows NUL/control/non-Latin-1; missing tests (chained redirect, no Location, redirect→404/HTML, headers on 2nd hop, real AbortSignal); HTTP-date Retry-After dropped; unreachable 'Too many redirects' throw; timeout per hop (2× worst case).
- **Task 5**: reader lock not released on mid-read error; stream-error test setTimeout not cleaned.
- **Task 6**: longest-match branch untested (no overlapping fixture prefixes); no tests for http-only service, >7d stale, malformed ranges; no negative caching during IANA outage (3 fetches per lookup after 24h); ASN '' → 0 accepted; bases last-write-wins.
- **Task 6**: rejected payload leaves this.parsed set (harmless); Service type/asRawFile narrower than runtime checks.
- **Task 7**: remarks/notices titles and redacted[].description not scrubbed or linted (currently boilerplate only); lint lacks no-links/no-adr assertions for people; arin-contact@google.com / network-abuse@google.com are role mailboxes (kept).
- **Task 7**: PERSON_KEY is a name heuristic (keys like *_holder/*_admin would not match) — rescan key inventory when adding fixtures; scrubber passes object values under PERSON_KEY (lint fails closed); unused k in lint loop.
- **Task 8**: sanitize.ts / reducers.test.ts contain raw invisible chars (U+200B.., U+202E) instead of \u escapes — fragile; rewrite as escapes.
- **Task 8**: clean() does not strip U+E0000–E007F tag characters (known prompt-injection channel), U+061C, U+00AD, U+180E.
- **Task 8**: clean tests don't cover C1/isolates/BOM/boundaries; truncation may split surrogate pair; snapshot stores undefined keys.
- **Task 9**: STALE text says "<RIR> RDAP is unreachable now" but stale is also served when the local limiter is exhausted or upstream sent a challenge page — use neutral wording ("could not refresh").
- **Task 9**: personal-contact render test has no negative leak assertion; LACNIC snapshot pointer uses APNIC test URL; budget test doesn't cover stale suffix/many prefixes/nameservers; age() doesn't clamp; render cast in budget loop; LACNIC autnum shows "AS28000  28000".
- **Task 10**: holder cleared renders "(none) ((none))"; same-timestamp tie-break / malformed null-until shadowing / collapse spans gaps; localeCompare on ISO strings; keyOf handle fallback could show a person handle for entity histories (Task 11 refuses personal entities first); at/since validated only by Task 12 schema; untested paths (full detail render, truncation line, renderAt not-covered/withdrawn, personal registrant, non-IP keys); redundant prev==null.
- **Task 10**: cap() counts UTF-16 units not bytes — non-ASCII covering names (≤120 chars after clean) could exceed 1500 in theory; header uncapped (bounded by key).
- **Task 11**: coalescing window between cache.get and inflight check can start a second call after a just-finished refresh; reducer TypeError/cache.put failure propagate without penalise; dead `?? 'apnic'` in entity history path; too_large doesn't penalise; no cache-content assertion for personal entities; no redirect allow-list wiring test.
- **Task 11**: cold ip/asn history stores no validatedFor, so one extra refetch can occur on the first later call with changed > latestFrom (bounded, once).
- **Task 11**: companion failing with upstream/too_large and no stale fallback is not counted → total 6; only during an upstream failure (limiter already penalised → history served stale), non-blocking.
- **Task 12**: Review Focus 2 at MCP boundary only tests AS-FOO (add IP bad-input + schema-rejection cases); DATE regex allows 2012-13-45; no test that since/detail change output; purity regex false-positive prone; outputSchema rir/cache are plain strings; resource test shallow.
- **Task 12**: historyView without meta ignores source line in byte budget (latent trap); no test for timeline-mode structured output.
- **Task 13**: README docs reference not a markdown link; TERMS_OF_USE link dead until Plan 4; placeholder contacts `you@example.net` / `github.com/you/...` look copyable — use `<operator contact>`; live.test.ts comment omits corepack.
- **Task 13**: stderr also carries config-error line/Node warnings; history cost described as 5 (≈5); Claude Desktop PATH/nvm note; no test that onError logs type only or that stdout has only protocol frames; "listening" logged before connection.

## TODO: migrate the repo to IEISI-ORG (owner: Terry, added 2026-10-04)

The repo is public at `github.com/tcsweetser/apnic-mcp`. Code and docs already point at `github.com/IEISI-ORG/rir-mcp`, so those links 404 until the move:
the User-Agent sent to every RIR (`REPO_URL` in `packages/core/src/rdap/user-agent.ts`), the operator contact `…/IEISI-ORG/rir-mcp/issues`, `TERMS_URL` in `packages/core/src/guide/text.ts`, and the clone commands in `README.md` and `docs/deployment.md`.

- [x] (done 2026-10-04) Transfer the repo to `IEISI-ORG` **and rename it to `rir-mcp`** (Settings → Transfer, or `gh api repos/tcsweetser/apnic-mcp/transfer -f new_owner=IEISI-ORG -f new_name=rir-mcp`). Keeping the name `apnic-mcp` would leave every URL above broken.
- [x] (done 2026-10-04) Point the local clone at the new home: `git remote set-url origin git@github.com:IEISI-ORG/rir-mcp.git`.
- [x] (resolved 2026-10-04) git access was briefly refused as "disabled" right after the transfer; a later `git fetch` from `IEISI-ORG/rir-mcp` succeeded.
- [ ] Check that the description, Issues (needed for the operator contact URL) and branch protection on `main` survived the transfer.
- [ ] Don't create a new `tcsweetser/apnic-mcp` afterwards: that breaks GitHub's redirect from the old URL.
- [ ] Re-run `corepack pnpm test:live` once, so the User-Agent link the RIRs see resolves.

## Before the repo goes public (spec §12)

- Plan 4: LICENSE (OpenRAIL-S), TERMS_OF_USE.md, SECURITY.md, CONTRIBUTING.md, CI (tests, weekly live drift, Dependabot, CodeQL, secret scanning) — after APNIC Legal Counsel review.
- Extend `test:live` to assert holders are non-personal and `meta.rir` is the expected RIR (catches AFRINIC's jCard sunset and redirect mislabelling).
- Confirm LACNIC limits with LACNIC; create the npm org `ieisi` before publishing.
