# rir-mcp Plan 1 — follow-ups

Deferred findings from the Plan 1 task reviews and the final whole-branch review (2026-09-30). None blocks Plan 1; the final reviewer triaged each as "can wait". Grouped by where they were found.

## Security hardening (do first)

- ~~Sanitiser: also strip variation selectors and blank fillers~~ — done 2026-10-03 (also U+FFA0 and lone surrogates).
- ~~Redirect allow-list ignores port and userinfo~~ — done 2026-10-03.
- ~~Non-ASCII handles upper-cased into ASCII (ß→SS, ı→I)~~ — done 2026-10-03; validated before upper-casing.
- ~~Reader lock not released on mid-read error~~ — done 2026-10-03.
- ~~Sanitiser algorithmic complexity (background commit review after `d40ac8d`)~~ — done 2026-10-06: email check scans one token per "@" (was a full-text match per `www.`: 15 s for 120 KB), the scheme rule no longer backtracks over letter runs (1 MB did not finish in 120 s), and `clean` reads at most 16× its output cap. Accepted: a field with over 16× `max` leading whitespace now cleans to nothing.
- Already resolved on review 2026-10-03: raw invisible characters in tests are `\u` escapes; tag characters, U+061C, U+00AD, U+180E are Cf and stripped; input echoes are bounded by the tool schemas (`max(64)`/`max(20)`).
- Fixture PII lint: `PERSON_KEY` is a key-name heuristic — rescan the key inventory whenever fixtures are re-recorded or a new source is added; lint notice titles and `redacted` descriptions too.

## Code review, iteration 35 (2026-10-06, 7286016..0b1f6da)

0 Critical, 1 Important, 7 Minor; all fixed in the iteration except Minor 7's email part (an email ending in "_" before "@" keeps the guillemet: an underscore before "@" can close emphasis, and such addresses are rare). Important: a refused companion lookup in entity/reverse-DNS history gave a one-unit retry time — every charge in a history request now reports the whole request's retry time.

## Workers best-practices review (2026-10-06, iteration 34)

Checked packages/worker against Cloudflare's Workers best practices (skill + docs). Clean: no Math.random, no `any`, no forced casts in sources, no passThroughOnException, no destructured ctx methods, no unawaited promises; DO extends the platform base class; generated binding types; compatibility date current (2026-10-01).

- **Fixed:** the edge gate was cached per `env` at module level; a rotated API_KEY could stay valid while an isolate was reused after a binding-only change. Now built per request (`a22e674`).
- **Deliberate exceptions (recorded):** traces stay off (they record outbound URLs containing queried values; the skill recommends them on); one global Durable Object (Q9, for exact worldwide limits).
- ~~StateDO builds its User-Agent from OPERATOR once per instance~~ — done 2026-10-06 (iteration 37): `serve` rebuilds the handler when OPERATOR differs from the value it was built with (all state is in SQLite; only per-key call-rate buckets and the IANA memo restart). Cloudflare documents a Durable Object reset for code updates only.

## Daily security audit 2026-10-06 (snapshot 7286016) and code review, iteration 30 — results

Audit: 0 Critical/High/Medium, 3 Low, 4 Info. Review: 0 Critical, 1 Important, 7 Minor. Fixed the same day:
- Audit L1 (re-graded Medium): a blocked registry cost three storage writes per refused call; now none (limiter `check()` before charging; refusals save nothing) (`7e551ee`).
- Review I1: a refused history's retry time is for the whole request (`93a4033`).
- Audit L2: reverse-DNS history uses only a zone computed from the address; history lines start with fixed text (`02f2b6f`).
- Audit L3: single-underscore emphasis neutralised.
- Audit I1, I4; review Minors 2, 4: gate options and infinite Retry-After fail closed; strict clamps; completion-map clear order (`83625ce`).
- SECURITY.md added; GitHub security settings asked as Q13 (all off on 2026-10-06).

Deferred:
- Review Minor 3 — **Ruling (2026-10-06): not fixed now.** Every upstream request still takes at least one token, so the registry's real rate is respected; only the self-imposed weight is understated in rare cases. An exact fix needs token metering through the fetcher; charging a fixed 5 would make histories with an uncached companion fail APNIC's burst of 5. Was: the history limiter weight counts a companion as an upstream token even when none was spent (cached not_found, stale after refusal, joined in-flight), so APNIC is charged 4 instead of 5. Have FetchOutcome report whether it acquired a token.
- Review Minors 5–6 done 2026-10-06 (small-quota gate assertion; per-tool leak lists). Edge log-reason tests done 2026-10-06. History/ASN/rDNS leak cases done 2026-10-06. (Worker GET-with-body cannot be built through fetch() in workerd; its unit test stands.) Was: Review Minors 5–7: test gaps (small-quota test asserts no gate state; end-to-end leak test lacks per-tool forbidden lists and history/ASN/rDNS cases; Worker GET-with-body not driven through workerd fetch; edge log reasons untested).
- ~~Review Minor 8: a holder that keeps its handle but loses its name renders "holder (none)".~~ Done 2026-10-06 ("name removed").
- ~~Audit I2: rangeToCidrs computes every CIDR before the 64 cap~~ Done 2026-10-06 (stops at the limit). Was (6.6 s CPU on a hostile 5,000-record IPv6 history); pass the limit in.
- Audit I3 residuals: `host` exemption keeps every www. in a value that starts with one; ~~combining marks (U+0336 overlay, Zalgo) pass~~ (done 2026-10-06: overlays dropped, stacks capped at 3).
- ~~Audit I4 remainder~~ Done 2026-10-06: deployment.md documents the 1 h cap (one probe per hour) and that Node keeps the pause in memory only.

## Code review, iteration 25 (2026-10-05, 2a39f48..068ee83) — deferred Minor

Fixed in the iteration: history quota capped per request (Important 1), quotas below 1 deny (2), fractional burst/hourly cap (3), GET with a body (4), edge log reasons (5), backward clock step (6), pre-1970 dates (7); plus a background commit review's finding that the first quotaWeight let an exhausted quota-1 key fetch history free (`56e8197`).

- ~~Holder rename display~~ Done 2026-10-05. Was: A holder rename that keeps its handle renders as "(none) (New Name)", which reads as "holder removed": render "renamed holder to New Name" when only holderName changed.

## Code review, iteration 20 (2026-10-05, df94156..6849036) — deferred Minors

Fixed in the iteration: sanitiser bypasses via character references, backslash escapes and `www.` after `_`/`-`/`.` (C1), with renderer-based tests; post-staleUntil IANA refetch storm (I1); entity-cap test (M1); strikethrough/bold (M2); marker without `//` (M4); docs wording (M7); comment (M8).

- ~~History header~~ Done 2026-10-05 (`9441938`, header starts "history of"). Was: History timeline lines start with a registry-controlled key (`render/history.ts:90`): a handle like `# X` or `1. X` would render as a heading or list item. Prefix the line or strip a leading `#`/list marker.
- ~~Heavy call on a small quota~~ Done 2026-10-05 — first attempt (`e571479`, per-charge cap) was incomplete and let quotas ≤0 through; fixed properly in iteration 25 (request-level quotaWeight with a metered companion, `56e8197`; quotas below 1 deny). Was: A weight above the client's quota (history = 5 for a quota of 1–4) is refused forever but told to retry: return a distinct message or cap the weight at the quota.
- ~~Call-rate docs~~ Done 2026-10-05. Was: `docs/deployment.md` says every tool call counts against the call rate; special-use and invalid inputs never reach it, and an IP/ASN history can take two tokens (and fall through to `history_unavailable` at the burst edge).

## Daily security audit 2026-10-05 (snapshot 731beb3) — results

Fresh-context auditor (Opus). No Critical or High. Fixed the same day:
- **F1 Medium** — per-client call-rate limit on every tool call, cached ones included (120/min, burst 60, in memory; each batch element counts); `observe` skips the state write for a repeated unit (`869be83`).
- **F2 Medium** — upstream `Retry-After` honoured: the limiter refuses the bucket until then (capped 1 h, persisted), read on 5xx too and as an HTTP date; IANA back-offs too (`6335b23`).
- **F3 Low → Medium** — links, images, code spans and URLs defanged in registry text; a background commit review then found bypasses (raw HTML, `www.` autolinks, escaped `\/\/`, angle autolinks), fixed the same day (`b07012d`); a second review (Markdown link injection: lenient `[x] (url)`, reference links, defang markers forming links) led to removing square brackets from registry text entirely (`821df51`). F3 itself: `dc2ed36`.
- **F4/F5/F6** — docs: one Node process per egress IP; WAF rate-limit rule for floods; cache-age note (`1e81e81`). **F7** `.claude/` ignored (`0b71b58`).

Deferred (Low/Info):
- ~~Bootstrap base URL shape~~ Done 2026-10-05. Was: Bootstrap base URLs are not checked for port, userinfo or path the way redirects are (IANA is trusted, over TLS).
- ~~A redirect from an RIR to itself makes a second request without charging a second token.~~ Done 2026-10-05.
- ~~Worker body deadline~~ Done 2026-10-05 (`4aff0c1`: buffered at the edge, 10 s / 64 KiB). Was: The Worker has no slow-body or request deadline (only authenticated clients can hold DO requests).
- ~~Dependency hygiene~~ Done 2026-10-05: `minimumReleaseAge: 4320` (3 days) in pnpm-workspace.yaml; the lockfile passes. **TODO after 2026-10-07:** remove the four `minimumReleaseAgeExclude` entries (wrangler 4.147.0, @cloudflare/vitest-plugin 1.3.6, mdast-util-from-markdown 2.1.0, mdast-util-to-markdown 2.2.0), which were installed before the policy and are then old enough. Caret ranges stay: the lockfile pins exact versions. Was: caret ranges and an `-alpha` miniflare in dev tooling.
- ~~Residual of audit 2026-10-03 #4: array caps in reducers~~ Done 2026-10-05 (`259b37d`; histories over 5,000 records refused as too_large). Was (status, nameservers, history `at` state, network `structuredContent`). The cache byte bound is done on both runtimes.

## Daily security audit 2026-10-03 (snapshot 998bb8a) — deferred Lows

Fixed the same day: Medium #1 (history domain keys raw → `dnsName`), Medium #2 (deleted personal entity's history served → reducer marks `personal`, service refuses), Low #3 (redirect query/fragment/path → RDAP-path check), Low #6 (`SingleKeyStore` NaN quota → validated).

- ~~**#4 Byte-bounded memory**~~ — done: cache byte bound 2026-10-04, array caps 2026-10-05 (`259b37d`). Was: `MemoryCache` caps 10k *entries*, not bytes; unusual upstream data (synthetic 5.3 MB history → 3.1 MB reduced) could hold GBs. Also uncapped arrays in `at`-mode text, history `structuredContent.state`, network `structuredContent`. Fix: cap array counts in reducers (e.g. 64 prefixes/status/nameservers, 2,000 history rows) and `cap()` the `at` lines; consider a byte budget in the cache.
- ~~**#5 Fixed hourly windows**~~ Done 2026-10-04 (`377f1af`) for the quota (sliding window, both runtimes). Scan detection keeps its fixed window by ruling: a sliding one would retain the previous hour's salted digests. Was: **#5 Fixed hourly windows in `MemoryClientGate`:** 60 calls at 00:59 + 60 at 01:00; same for 200+200 scan units. RIR load still bounded by the per-RIR limiter. Fix: sliding window (two buckets with weighted carry-over). Revisit together with the StateDO gate in Plan 3 so both runtimes share the algorithm.
- ~~**IANA bootstrap refetch before `charge`:**~~ *(Closed 2026-10-05: memo, 5-minute and 30-second back-offs bound it to about 3 fetches per 30 s at worst — true only after the iteration-20 fix: before it, an index past its 7-day stale lifetime disabled the cold back-off.)* during an IANA outage, over-quota clients still trigger bootstrap refetches (routing runs before the quota check). Load goes to IANA, not RIRs. Fold into the existing "no negative caching during IANA outage" item (Task 6).

## Code review, iteration 5 (2026-10-04, Plan 2 Tasks 1–7) — deferred Minors

Fixed the same day: rDNS charged per zone, limiter refusal spent quota, NaN quota fail-open in the gate. Allow-list format validation is folded into Plan 2 Task 8.

- ~~keys-file recovery line~~ Done 2026-10-04. Was: keys-file: log one "keys file reloaded" line when a broken file becomes valid again (operators cannot see recovery today).
- ~~keys.ts stdin~~ Done 2026-10-04 (`9317265`). Was: `scripts/keys.ts hash <key>` puts the key in shell history and `ps`; read it from stdin when the argument is `-` or absent.
- The `rir-mcp` bin only runs via tsx (extensionless imports; workspace core is TS source) — needs the Plan 4 build.
- ~~Spec logged fields~~ Done 2026-10-04 (spec now says outcome code). Was: Spec §7 lists "upstream status" as a logged field; `CallLog` logs the outcome code. Update the spec or add the field.
- 413 factory assertion done 2026-10-04 (`ef423d4`). ~~No slow-body timeout test~~ (done 2026-10-05: injectable timeouts; 408 test; timeout check every 5 s). Was: Tests: no slow-body timeout test; the 413 test should assert the per-request server factory never ran (spy on `service.forClient`).
- ~~EADDRINUSE~~ Done 2026-10-04. Was: EADDRINUSE at startup surfaces as an unhandled rejection rather than a clean `rir-mcp:` message.

## Plan 2 Task 8 — deferred

- ~~README: add the HTTP-mode one-liner~~ Done 2026-10-04 (iteration 8, `347d3b8`): README rewritten with an HTTP quick start.

## Code review, iteration 10 (2026-10-04, Plan 3 Tasks 1–5) — deferred Minors

Fixed in the iteration: unread upstream bodies are cancelled (`10b5234`); scan digests are dropped on suspension and purged by a DO alarm after their window (`26f3922`). The Task 7 requirements (validate `OPERATOR` via `buildUserAgent`, catch `serve` errors) are in the Plan 3 ledger.

- ~~**Before the first Worker deploy:**~~ Done 2026-10-04 (`5235d76`): running totals in memory, `bytes` before `value`, `schema_version` 1. Was: the `cache` table reads every row's `bytes` on each put (`count(*)`, `sum(bytes)`), and `bytes` sits after the large `value` column. Move `bytes` before `value` or keep running totals in `meta`. Also write a `schema_version` to `meta` now: `CREATE TABLE IF NOT EXISTS` cannot change an existing table.
- ~~Bootstrap re-reads~~ Done 2026-10-04 (`1ad0f45`): parsed index reused while fresh; 5-minute back-off after a failed refresh (also fixes the Task 6 "no negative caching during IANA outage" item). Each record cache hit's row write is skipped while the entry is among the most recent tenth (2026-10-04). Was: Each cache hit is a SQLite row write (`used_at`), and the IANA bootstrap row (~11.5 KB) is read and parsed 2–3 times per lookup. Skip recent recency updates, or keep the parsed bootstrap in memory keyed on `fetchedAt`.
- ~~Suspension and hourly-window eviction tests~~ Done 2026-10-04 (`0b2270c`). Still open:  `SqlCache` run through the `MemoryCache` cases; a history lookup through the DO.
- ~~`authInfo` is built in both `core/src/http/edge.ts` and `handler.ts`: extract `authInfoFor(client)`.~~ Done 2026-10-04 (`c3aa169`).
- ~~README says raw RDAP JSON is "4–250 KB"; the fixtures go up to 370 KB (history). Reword.~~ Done 2026-10-04.
- ~~Task 8 docs~~ (done 2026-10-04/05: persistence described; invocation logs and traces off). Was: describe Worker persistence accurately (suspensions survive restarts; salted digests persist for up to an hour), and check whether Workers Logs records request headers such as `Authorization` before deploying.

## Plan 3 (Cloudflare Worker) — open items after Task 8

- Not yet run on a live Cloudflare account. First deploy: follow `docs/deployment.md` → Cloudflare Workers, then run one live lookup per RIR through the Worker. Do the iteration-10 "before the first Worker deploy" items first (cache column order, `schema_version`).
- ~~`wrangler` sends anonymous usage telemetry by default~~ — done 2026-10-06: `send_metrics: false` in `wrangler.jsonc`.
- ~~Single-key Worker deployments have a fixed quota of 60/hour~~ — done 2026-10-06 (iteration 38): `QUOTA_PER_HOUR` var, validated like Node's `RIR_MCP_QUOTA_PER_HOUR` (503 when invalid).
- Urgent revocation (StateDO deny-list, admin endpoint) deferred by Q10.

## Plan 3 final review (2026-10-04) — deferred Minors

Fixed at the review: kv mode without the KV binding now answers 503, and key-store failures log `auth_error` (`41fc1c3`); traces pinned off, docs corrected for browser clients, tail and retention, spec §7 amended (`8af70ce`).

- ~~Quota bound~~ Done 2026-10-04 (`e8af5cb`). Was: `scripts/keys.ts` and `parseKeyRecords` accept any positive integer quota, e.g. `1e+23` (effectively unlimited). Cap at 1,000,000 like `RIR_MCP_QUOTA_PER_HOUR`. `revoke` rejects an uppercase hex hash instead of lower-casing it.
- ~~Alarm arming~~ Done 2026-10-04. Was: `StateDO.serve`: if `getAlarm`/`setAlarm` throws after the handler finished, the answer is lost although the quota was charged. Wrap the arming in try/catch and log the type.
- ~~Allow-list case~~ Done 2026-10-04. Was: `ALLOWED_HOSTS` / `RIR_MCP_ALLOWED_HOSTS` are compared case-sensitively with the SDK's lower-cased hostname: an uppercase entry gives a permanent 403. Lower-case both lists when loading.
- ~~`.gitignore`: add `.wrangler/` and `.dev.vars.*`.~~ Done 2026-10-04.
- ~~Tests: KV `get` throwing through the Worker entry; 403 Host/Origin create no DO.~~ Done 2026-10-04.
- ~~Node idle scan hashes~~ Done 2026-10-04 (`1d428b2`, hourly `clearExpiredUnits`). Was: Node keeps an idle client's scan hashes in memory until its next request or a restart. Add a periodic sweep, for parity with the Worker's alarm.

## Code review, iteration 15 (2026-10-04, follow-ups 641fd1a..df94156) — deferred Minors

Fixed in the iteration: bootstrap memo capped at 1 h with an in-memory stale fallback and a `staleUntil` bound (`3fdba21`; regression from `1ad0f45`, reproduced by the reviewer); unversioned cache table rebuilt, unknown version tested (`e2b87d0`); allow-list entries stored in canonical form, incl. IPv6 (`de38145`); quota range documented (`ef3dc5e`). Note: the busy-server test passes through either the 1 h cap or the memory fallback, so no single test pins the cap alone.

- ~~Order-dependent "no DO" assertions~~ Done 2026-10-04 (STATE spy). Was: Worker "creates no DO" assertions depend on test order (the singleton `'state'` DO persists within the file): use an `env.STATE` whose `getByName` is a spy, as the DO-failure test does.
- ~~Alarm log assertion~~ Done 2026-10-04. Was: Alarm-failure test does not assert the log line (`error: 'Error'`, no message).
- ~~authInfoFor module~~ Done 2026-10-04 (`http/auth-info.ts`). Was: `authInfoFor` lives in `http/handler.ts`, so `edge.ts` imports the server graph: move it to `http/auth-info.ts`.
- ~~Cold-start IANA back-off~~ Done 2026-10-04 (`c69a3b4`, 30 s). Was: Cold start during an IANA outage (nothing cached) still makes 3 fetches per lookup: no back-off without data.

## Parked at final review

- history names bootstrap RIR when the redirect-detecting current lookup fails (real, minor; the user still gets a correct refusal or can retry)
- ~~sanitiser misses variation selectors~~ (verified 2026-10-05: stripped). Was: sanitiser misses variation selectors U+FE00–FE0F / U+E0100–E01EF (Mn) and blank Lo fillers (U+3164, U+115F, U+1160, U+2800) (real, deferred to a follow-up hardening item (hidden-payload channel similar to tag chars; low likelihood in RIR data))
- ZWJ/ZWNJ become spaces (acceptable, not a regression)
- operator contact may end with backslash (RFC 9110 comment quoted-pair) (grammar-only, no injection)
- ~~redirect test doesn't assert weight~~ (done 2026-10-06: history redirect hop charged the full weight, mutation-checked); ~~scripts/fixtures-record.ts usage comment still says you@example.net~~ (fixed 2026-10-05)

## Deferred minors by task

- **Task 1**: ~~rangeToCidrs lacks IPv6/single-address/start>end tests~~ (done 2026-10-05); ~~prefixContains lacks IPv6/equal cases~~ (done 2026-10-05).
- ~~**Task 1**: `1.1.1.1/024` accepted as /24~~ (done 2026-10-05, refused).
- ~~**Task 2**: toUpperCase maps non-ASCII (ß→SS, ı→I) into valid handles; reject non-ASCII before upper-casing.~~ (done earlier, `input/handle.ts`)
- **Task 2**: inferRirFromHandle expects parseHandle output (no normalisation/doc).
- **Task 2**: no tests for 64-char handle boundary, handle hint, IPv6 /30 /50 /96, IPv4 /24 /16 zones; `4608.0` parses as asdot silently; error messages echo raw input (bounded: the tool schemas cap inputs at 64 characters, so not a risk).
- **Task 3**: tests cover 10/27 IP rows; no table-driven drift guard; longest-prefix branch unexercised (no overlapping rows).
- ~~**Task 4**: refill applies one rate across a span straddling penaltyUntil; no test for rate restoration after 5 min.~~ (done 2026-10-05, `3252afe`)
- **Task 4**: cost=min(weight,burst) undocumented/untested (LACNIC history would drain 3 not 5; history is APNIC-only so moot today).
- **Task 4**: hourly window is fixed not rolling (≤2× cap across boundary; unreachable for LACNIC at 10/min).
- **Task 4**: backward clock step (fails safe; since 2026-10-05 the bucket clock never moves back); ~~clampProfile accepts 0/negative/NaN~~ (done 2026-10-05; NaN disabled the limiter); penalise ignores unknown bucket while acquire throws.
- **Task 4**: cache tests lack put-overwrite and expired-vs-capacity cases.
- **Task 5**: ~~redirect allowlist ignores port/userinfo~~ (done 2026-10-03); ~~buildUserAgent allows NUL/control/non-Latin-1~~ (verified 2026-10-06: printable ASCII only); missing tests (chained redirect, no Location, redirect→404/HTML, headers on 2nd hop, real AbortSignal); ~~HTTP-date Retry-After dropped~~ (done 2026-10-05, `6335b23`); unreachable 'Too many redirects' throw; timeout per hop (2× worst case).
- **Task 5**: ~~reader lock not released on mid-read error~~ (verified 2026-10-05: released in finally); stream-error test setTimeout not cleaned.
- **Task 6**: longest-match branch untested (no overlapping fixture prefixes); no tests for http-only service, >7d stale, malformed ranges; ~~no negative caching during IANA outage~~ (verified 2026-10-06: 5-min retry and 30-s cold back-off); ~~ASN '' → 0 accepted~~ (done 2026-10-06: ranges must be digits, start ≤ end); bases last-write-wins.
- **Task 6**: rejected payload leaves this.parsed set (harmless); Service type/asRawFile narrower than runtime checks.
- **Task 7**: remarks/notices titles and redacted[].description not scrubbed or linted (currently boilerplate only); ~~lint lacks no-adr assertions for people~~ (done 2026-10-05: a person's vCard must be exactly the scrubbed form); arin-contact@google.com / network-abuse@google.com are role mailboxes (kept).
- **Task 7**: PERSON_KEY is a name heuristic (keys like *_holder/*_admin would not match) — rescan key inventory when adding fixtures; scrubber passes object values under PERSON_KEY (lint fails closed); unused k in lint loop.
- ~~**Task 8**: raw invisible chars in sources~~ (verified 2026-10-05: none remain). Was: sanitize.ts / reducers.test.ts contain raw invisible chars (U+200B.., U+202E) instead of \u escapes — fragile; rewrite as escapes.
- ~~**Task 8**: tag characters etc.~~ (verified 2026-10-05: all stripped by UNSAFE). Was: clean() does not strip U+E0000–E007F tag characters (known prompt-injection channel), U+061C, U+00AD, U+180E.
- **Task 8**: clean tests don't cover C1/isolates/BOM/boundaries; ~~truncation may split surrogate pair~~ (verified 2026-10-06: truncates by code point); snapshot stores undefined keys.
- ~~**Task 9**: STALE wording~~ (verified 2026-10-05: "could not refresh"). Was: STALE text says "<RIR> RDAP is unreachable now" but stale is also served when the local limiter is exhausted or upstream sent a challenge page — use neutral wording ("could not refresh").
- **Task 9**: ~~personal-contact render test has no negative leak assertion~~ (done 2026-10-05: end-to-end MCP test with a real-looking person, mutation-checked); LACNIC snapshot pointer uses APNIC test URL; budget test doesn't cover stale suffix/many prefixes/nameservers; age() doesn't clamp; render cast in budget loop; LACNIC autnum shows "AS28000  28000".
- **Task 10**: ~~holder cleared renders "(none) ((none))"~~ (done 2026-10-05); same-timestamp tie-break / malformed null-until shadowing / collapse spans gaps; localeCompare on ISO strings; keyOf handle fallback could show a person handle for entity histories (Task 11 refuses personal entities first); at/since validated only by Task 12 schema; untested paths (full detail render, truncation line, renderAt not-covered/withdrawn, personal registrant, non-IP keys); redundant prev==null.
- ~~**Task 10**: cap() counts UTF-16 units not bytes~~ (done 2026-10-05: byte cap between characters). Was: cap() counts UTF-16 units not bytes — non-ASCII covering names (≤120 chars after clean) could exceed 1500 in theory; header uncapped (bounded by key).
- **Task 11**: ~~coalescing window between cache.get and inflight check can start a second call after a just-finished refresh~~ (done 2026-10-05, completion counter); reducer TypeError/cache.put failure propagate without penalise; dead `?? 'apnic'` in entity history path; too_large doesn't penalise; no cache-content assertion for personal entities; no redirect allow-list wiring test.
- **Task 11**: cold ip/asn history stores no validatedFor, so one extra refetch can occur on the first later call with changed > latestFrom (bounded, once).
- **Task 11**: companion failing with upstream/too_large and no stale fallback is not counted → total 6; only during an upstream failure (limiter already penalised → history served stale), non-blocking.
- **Task 12**: ~~Review Focus 2 at MCP boundary only tests AS-FOO~~ (done 2026-10-05); ~~DATE regex allows 2012-13-45~~ (done 2026-10-05); no test that since/detail change output; purity regex false-positive prone; outputSchema rir/cache are plain strings; resource test shallow.
- **Task 12**: ~~historyView without meta ignores source line~~ (done 2026-10-05: meta required); no test for timeline-mode structured output.
- **Task 13**: README docs reference not a markdown link; TERMS_OF_USE link dead until Plan 4; placeholder contacts `you@example.net` / `github.com/you/...` look copyable — use `<operator contact>`; live.test.ts comment omits corepack.
- **Task 13**: stderr also carries config-error line/Node warnings; history cost described as 5 (≈5); Claude Desktop PATH/nvm note; no test that onError logs type only ~~or that stdout has only protocol frames~~ (done 2026-10-06: stdio process test, mutation-checked); "listening" logged before connection.

## TODO: migrate the repo to IEISI-ORG (owner: Terry, added 2026-10-04)

The repo is public at `github.com/tcsweetser/apnic-mcp`. Code and docs already point at `github.com/IEISI-ORG/rir-mcp`, so those links 404 until the move:
the User-Agent sent to every RIR (`REPO_URL` in `packages/core/src/rdap/user-agent.ts`), the operator contact `…/IEISI-ORG/rir-mcp/issues`, `TERMS_URL` in `packages/core/src/guide/text.ts`, and the clone commands in `README.md` and `docs/deployment.md`.

- [x] (done 2026-10-04) Transfer the repo to `IEISI-ORG` **and rename it to `rir-mcp`** (Settings → Transfer, or `gh api repos/tcsweetser/apnic-mcp/transfer -f new_owner=IEISI-ORG -f new_name=rir-mcp`). Keeping the name `apnic-mcp` would leave every URL above broken.
- [x] (done 2026-10-04) Point the local clone at the new home: `git remote set-url origin git@github.com:IEISI-ORG/rir-mcp.git`.
- [x] (resolved 2026-10-04) git access was briefly refused as "disabled" right after the transfer; a later `git fetch` from `IEISI-ORG/rir-mcp` succeeded.
- [x] (verified 2026-10-06) Description, Issues and branch protection on `main` (force-push and deletion blocked, no PR requirement) survived the transfer.
- [ ] Don't create a new `tcsweetser/apnic-mcp` afterwards: that breaks GitHub's redirect from the old URL.
- [x] (done 2026-10-06) `corepack pnpm test:live` re-run with the IEISI-ORG User-Agent: 5/5 RIRs pass.

## Before the repo goes public (spec §12)

- Plan 4: LICENSE (OpenRAIL-S), TERMS_OF_USE.md, SECURITY.md, CONTRIBUTING.md, CI (tests, weekly live drift, Dependabot, CodeQL, secret scanning) — after APNIC Legal Counsel review.
- ~~Extend `test:live` to assert holders are non-personal and `meta.rir` is the expected RIR~~ — done 2026-10-06 (holder present and not personal; `meta.rir` was already checked).
- Confirm LACNIC limits with LACNIC; create the npm org `ieisi` before publishing.
