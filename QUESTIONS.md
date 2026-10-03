# Open questions

Questions raised while working through the plans unattended. Write your answer under **Answer:**. Until you answer, work continues on the stated default, and anything built on a default is easy to change.

---

## Q1 (2026-10-03, Plan 2) — How long should a scan-detector suspension last?

Spec §7 says "above 200 → suspend client, alert operator" but gives no duration. Node keeps state in memory, so a restart lifts any suspension anyway.

**Default:** 24 hours, then the client starts with a fresh count. The alert is one JSON line on stderr: `{"alert":"client_suspended","client":"<id>"}`.

**Answer:** Approved.

---

## Q2 (2026-10-03, Plan 2) — Do handles count toward the scan detector?

Spec §7 counts distinct /24s, /48s and ASNs. Entity handles (e.g. `ORG-ARAD1-AP`) are also a harvesting path.

**Default:** yes. Handles count as their own unit (`h:<rir>:<handle>`) toward the same threshold of 200.

**Answer:**

---

## Q3 (2026-10-03, Plan 2) — Format of `clientId`

`clientId` appears in logs. To keep personal data out of logs, the default only allows opaque IDs that match `^[a-z0-9][a-z0-9-]{0,31}$` (e.g. `acme-noc`, `c0042`). A name with spaces or an email address is rejected.

**Default:** as above.

**Answer:**

---

## Q4 (2026-10-03, Plan 2) — Node keys-file format and revocation

Per-user mode reads `RIR_MCP_KEYS_FILE`, a JSON array of `{sha256, clientId, quotaPerHour, touVersion?, revoked?}`. This matches the KV record in spec §7. The file is read at startup. Revoking a key means setting `revoked: true` or deleting the line, then restarting.

**Default:** read at startup only, no live reload. Reloading on SIGHUP can come later if you want it.

**Answer:** rethink spec, if this deployed on CloudFlare, how does this work?

**Reply (2026-10-03, iteration 2):** On Cloudflare there is no keys file and no restart. Here is how Plan 3 works under spec §7:

| | Cloudflare (Plan 3) | Node (Plan 2, revised) |
|---|---|---|
| Where keys live | KV namespace `API_KEYS`: key = `sha256(apiKey)`, value = `{clientId, quotaPerHour, touVersion, revoked}` | `RIR_MCP_KEYS_FILE`, same records |
| Lookup per request | Worker hashes the bearer token and calls `KV.get(hash)` (edge-cached ≤ 60 s) | in-memory map, rebuilt when the file changes |
| Add a key | `scripts/keys.ts new` → writes KV; active within ~60 s everywhere | `scripts/keys.ts new` → appends to file; active within 30 s |
| Revoke | set `revoked: true` in KV (≤ 60 s) **and** add the hash to a deny-list in the `StateDO` Durable Object (immediate). The deny-list check uses the per-request DO call the quota check already makes, so it adds no extra round trip. | set `revoked: true` in the file; active within 30 s |
| Quota, scan counts, suspensions | `StateDO` (global, survives deploys); an operator can lift a suspension | memory (lost on restart) |
| Single-key mode | Worker secret `API_KEY`; rotate with `wrangler secret put` | `RIR_MCP_API_KEY`; restart to rotate |

The rethink: Node should behave like KV, so operators get the same model on both runtimes ("edit the keys, wait under a minute"). Plan 2 changes:
1. **Node reloads the keys file when it changes.** Read it at most every 30 s and reload when the contents differ. If the file becomes unreadable or invalid, reject every key until it is fixed and log one error line. Fail closed, at startup and at runtime. *(Revised the same day: the first version kept the old keys on a bad file, so a revocation with a typo in it would have left old keys working.)*
2. **The `KeyStore` port and `RecordKeyStore` are unchanged.** Cloudflare gets `KvKeyStore` plus the DO deny-list in Plan 3. Node gets `FileKeyStore`, which wraps `RecordKeyStore`.
3. **`scripts/keys.ts` gets `--target file|kv`.** Plan 2 builds `file`; Plan 3 adds `kv`.

**Default from now on:** the revised Node design above. It replaces "read at startup only" and is recorded in spec §7. Say so below if you'd rather keep restart-to-revoke on Node.

**Answer (follow-up):** Approved.

---

## Q5 (2026-10-03, Plan 2) — Does a cross-RIR redirect use one quota unit or two?

A lookup that APNIC redirects to ARIN makes two upstream HTTP requests, but answers one question.

**Answer:** charge the client's quota once per logical lookup. Each RIR's own rate limiter is still charged per hop, so the RIRs stay protected.

---

## Q6 (2026-10-03, Plan 2) — Docker image

Spec §10 lists Docker for self-hosted HTTP. Plan 2 does not include it.

**Default:** move the Dockerfile to Plan 4 (packaging, CI, publishing), so it is built together with the npm package and CI.

**Answer:**

---

## Q7 (2026-10-03, Plan 2) — Default HTTP port

**Default:** `8787`, override with `RIR_MCP_HTTP_PORT`. The server binds `127.0.0.1` unless `RIR_MCP_HTTP_HOST` is set. A non-loopback bind also needs `RIR_MCP_ALLOWED_HOSTS`, as protection against DNS rebinding.

**Answer:** pick a port not in use so commonly

**Reply (2026-10-03, iteration 3):** Default is now **4608**. IANA lists it as unassigned (block 4607–4620), it is clear of common dev ports (8787 is `wrangler dev`'s default and would collide in Plan 3), and it is APNIC's AS number, so it is easy to remember. Override with `RIR_MCP_HTTP_PORT`.

---

## Q8 (2026-10-03, general) — Push to GitHub?

There is still no git remote, so all work is local on `main`.

**Default:** stay local. I won't add a remote or push unless you say so. Pushing needs a check first that the amended-out commit `fcc65eb` is not reachable.

**Answer:**  set up a public repo under https://github.com/orgs/IEISI-ORG/ and make sure there's a well written README

**Reply (2026-10-03, iteration 3):** Not done. Claude Code's permission check blocked repo creation and pushing in this unattended session, so nothing was created or pushed, and README work stopped too. This is waiting on you. Before you go public, note the earlier decision that LICENSE/TERMS_OF_USE (Plan 4) should follow APNIC Legal Counsel review. A private repo first would avoid that conflict. Checks already done: no secrets in history; only role or `example.*` email addresses; the amended-out commit `fcc65eb` is not reachable from any branch or tag.


---

## Q9 (2026-10-04, Plan 3) — Durable Object layout: "DO as the server"

Spec §6 has one `StateDO` that the Worker calls for each cache, limiter and quota operation. A Durable Object lives in one location. A user far from it would pay a cross-region round trip for each of the ~5 sequential calls per lookup, which is over a second from the other side of the world.

**Default:** the Worker does the cheap checks at the edge (path, Host, Origin, API key via KV/secret), then forwards the request to the single `StateDO`, which runs the MCP handler itself. Cache, limiter, quota and scan state are then local SQLite calls, so there is one round trip per request. A single instance also makes rate limits and in-flight de-duplication exact worldwide. Expected volume (Slack-style Q&A) is far below one DO's capacity. If it ever isn't, the ports allow sharding by RIR later.

**Answer:**

---

## Q10 (2026-10-04, Plan 3) — Immediate revocation and lifting suspensions on Cloudflare

Spec §7 mentions a `StateDO` deny-list for urgent revocation. Writing to it needs an admin endpoint (or similar) on a public Worker, which is new attack surface.

**Default:** no admin endpoint in Plan 3. Revocation goes through KV (`revoked: true`, effective within about 60 s), and suspensions expire after 24 h (Q1). An admin endpoint protected by a separate `ADMIN_API_KEY` secret can be added later if you need faster revocation or manual unsuspend.

**Answer:**

---

## Q11 (2026-10-04, Plan 3) — Deploying to Cloudflare

Plan 3 builds and tests the Worker locally (workerd via the Cloudflare Vitest plugin). It does not deploy, log in to Cloudflare, or create KV namespaces.

**Default:** no deployment. The docs give the exact `wrangler` commands for you to run when you're ready. Tell me if you want a deploy and which account to use.

**Answer:**

---

## Q12 (2026-10-04, Plan 3) — Test runner version for the Worker package

Cloudflare's Vitest plugin (`@cloudflare/vitest-plugin` 1.3.6) supports Vitest 4 only. The repo uses Vitest 5.

**Default:** `packages/worker` pins Vitest 4 with its own config and runs as `corepack pnpm test:worker`. `corepack pnpm test` stays on Vitest 5 for core and node. I'll unify the two when the plugin supports Vitest 5.

**Answer:**
