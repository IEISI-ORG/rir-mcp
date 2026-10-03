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

**Answer:**

---

## Q5 (2026-10-03, Plan 2) — Does a cross-RIR redirect use one quota unit or two?

A lookup that APNIC redirects to ARIN makes two upstream HTTP requests, but answers one question.

**Default:** charge the client's quota once per logical lookup. Each RIR's own rate limiter is still charged per hop, so the RIRs stay protected.

**Answer:**

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
