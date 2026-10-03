# Open questions

Questions raised while working through the plans unattended. Write your answer under **Answer:**. Until you answer, work continues on the stated default, and anything built on a default is easy to change.

---

## Q1 (2026-10-03, Plan 2) — How long should a scan-detector suspension last?

Spec §7 says "above 200 → suspend client, alert operator" but gives no duration. Node keeps state in memory, so a restart lifts any suspension anyway.

**Default:** 24 hours, then the client starts with a fresh count. The alert is one JSON line on stderr: `{"alert":"client_suspended","client":"<id>"}`.

**Answer:**

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
1. **Node reloads the keys file when it changes.** Check mtime at most every 30 s. If the new file is invalid, keep the last good key set and log one error line. Fail closed only at startup.
2. **The `KeyStore` port and `RecordKeyStore` are unchanged.** Cloudflare gets `KvKeyStore` plus the DO deny-list in Plan 3. Node gets `FileKeyStore`, which wraps `RecordKeyStore`.
3. **`scripts/keys.ts` gets `--target file|kv`.** Plan 2 builds `file`; Plan 3 adds `kv`.

**Default from now on:** the revised Node design above. It replaces "read at startup only" and is recorded in spec §7. Say so below if you'd rather keep restart-to-revoke on Node.

**Answer (follow-up):**

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

**Answer:**

---

## Q8 (2026-10-03, general) — Push to GitHub?

There is still no git remote, so all work is local on `main`.

**Default:** stay local. I won't add a remote or push unless you say so. Pushing needs a check first that the amended-out commit `fcc65eb` is not reachable.

**Answer:**
