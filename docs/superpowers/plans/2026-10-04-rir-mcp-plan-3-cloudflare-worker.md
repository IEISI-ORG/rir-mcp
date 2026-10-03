# rir-mcp Plan 3 — Cloudflare Worker (StateDO as the server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve rir-mcp from Cloudflare: an edge Worker checks path, Host, Origin and API key, then hands the request to one SQLite-backed Durable Object that runs the MCP handler with persistent cache, rate limits, quotas and scan detection.

**Architecture:** "DO as the server" (QUESTIONS.md Q9). The Worker (`packages/worker/src/index.ts`) does only cheap checks (the same `edgeGate` Node uses, moved to core) and key lookup (secret `API_KEY` or KV `API_KEYS`), then calls `StateDO.serve(request, client)` over RPC. The single `StateDO` builds a `RirService` over SQLite-backed ports and answers with the same `mcpHandler` Node uses. One round trip per request, and exact global rate limiting and in-flight de-duplication. Limiter and gate algorithms stay in core: they take an injectable synchronous state map (a `Map` in Node, a SQLite table in the DO).

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (SQLite storage, RPC), KV, wrangler 4, `@cloudflare/vitest-plugin` 1.3 on Vitest 4 (worker package only, Q12), MCP SDK v2.2.

**Spec:** `docs/superpowers/specs/2026-09-30-rir-mcp-core-design.md` (§3, §6 backends, §7 auth incl. the 2026-10-03 revocation-parity amendment, §10). Spec §6 "one StateDO holds all shared state" holds; what changes is that the DO also runs the handler (Task 8 amends §3/§6).

## Global Constraints

- Every rule from Plan 2's Global Constraints still applies (no PII; value-free logs; Bearer only; hashes only; constant-time compare; fail closed; Host/Origin validation; quota 60/h, cache hits free; scan detector 200 distinct units/h → 24 h suspension; core imports no `node:` and no `cloudflare:` modules; files < 400 lines; per-RIR limits; no new runtime dependencies in core).
- Cloudflare auth (spec §7): per-user mode = KV `API_KEYS`, key `sha256(key)` hex → `{clientId, quotaPerHour, touVersion?, revoked?}`; single key = secret `API_KEY`; per-user takes precedence; neither → every request answered 503 and one log line per request (`{"alert":"no_auth_configured"}`), never served.
- `OPERATOR` (Worker var) is required, as `RIR_MCP_OPERATOR` is for Node; missing → 503 like missing auth.
- `ALLOWED_HOSTS` (Worker var, comma list of bare hostnames) is required; missing → 503. `ALLOWED_ORIGINS` optional, defaults to none (browser `Origin` requests rejected).
- No deployment, no `wrangler login`, no KV namespace creation, no network calls to Cloudflare from scripts (Q11). Tests run locally in workerd.
- `corepack pnpm test` (Vitest 5: core + node) and `corepack pnpm test:worker` (Vitest 4: worker) both pass at every commit; `corepack pnpm typecheck` covers core, node and worker.
- RDAP fetches from the DO keep the operator User-Agent (spec §5) and the bootstrap-only host allow-list.

## Review Focus

1. A Worker request that reaches `StateDO.serve` without passing the edge checks (e.g. a second exported fetch path, or `serve` callable with a forged client) → impossible: the DO is reachable only through the binding, and `serve` is only called after `edgeGate` succeeds. Test in Task 7 (unauthenticated request never creates a DO instance: `listDurableObjectIds` stays empty).
2. A KV record that is malformed (bad JSON, missing quota, `quotaPerHour: 0`, wrong clientId format) → treated as no key (401), never as unlimited or as a crash. Test in Task 6.
3. DO eviction mid-hour → quota, scan counts, suspensions and LACNIC hourly windows survive (persisted), so pausing a minute does not reset a client's quota. Test in Task 4 (`evictDurableObject`, then state is unchanged).
4. The cache in the DO grows without bound → bounded by entry count and total bytes, evicting least-recently-used. Test in Task 4.
5. Both `API_KEY` and `API_KEYS` absent, or `OPERATOR` / `ALLOWED_HOSTS` absent → 503 on every request, nothing served, no DO created. Test in Task 7.

---

### Task 1: Injectable state maps for the limiter and gate (core)

**Files:**
- Create: `packages/core/src/memory/state-map.ts`
- Modify: `packages/core/src/memory/rate-limiter.ts`, `packages/core/src/memory/client-gate.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/memory/state-map.test.ts`

**Interfaces:**
- Produces:
  - `interface StateMap<V> { get(key: string): V | undefined; set(key: string, value: V): void }` — synchronous; values are plain JSON. Callers must `set` after every change (the SQLite implementation persists on `set`).
  - `MemoryRateLimiter(profiles, clock, state?: StateMap<BucketState>)`; `export interface BucketState { tokens; updatedAt; penaltyUntil; windowStart; windowCount }` (all numbers).
  - `MemoryClientGate(clock, opts?: ClientGateOptions & { state?: StateMap<ClientState>; salt?: string })`; `export interface ClientState { windowStart: number; used: number; units: string[]; suspendedUntil: number }`.

Behaviour: unchanged. Gate `observe` computes the digest **before** reading state so read-modify-write has no `await` inside it (atomic in a DO).

- [ ] **Step 1: Failing test** — `state-map.test.ts` passes a `RecordingMap` (wraps a `Map`, deep-copies values on `get`/`set`, i.e. JSON round-trip) to both classes and asserts: (a) after `acquire`, `penalise`, `charge`, `refund`, `observe` the persisted value reflects the change (tokens decreased, `used` increased, `units` length grew, `suspendedUntil` set); (b) a second instance built over the same map with the same salt continues the counts (quota exhausted stays exhausted; scan count continues to the threshold); (c) JSON round-trip loses nothing (no `Set`).
- [ ] **Step 2: Run** — FAIL (constructors ignore the map; `units` is a `Set`).
- [ ] **Step 3: Implement** — replace the private `Map`s with the injected `StateMap` (default `new Map()`); work on a copy and `set` it at the end of each public method; `units: string[]` (dedupe with `includes`; ≤ threshold + 1 entries); `salt` option (default random as now).
- [ ] **Step 4:** `corepack pnpm test && corepack pnpm typecheck` — all existing limiter/gate tests pass unchanged.
- [ ] **Step 5: Commit** — `refactor(core): run limiter and gate over an injectable state map`

---

### Task 2: Move the HTTP gate and MCP handler to core (core + node)

**Files:**
- Create: `packages/core/src/http/edge.ts`, `packages/core/src/http/handler.ts`
- Modify: `packages/node/src/http-app.ts` (compose the two), `packages/core/src/index.ts`
- Test: `packages/core/test/http/edge.test.ts` (unit, web `Request`s), existing `packages/node/test/http.test.ts` unchanged and passing

**Interfaces:**
- Produces:
  - `edgeGate(opts: { keyStore: KeyStore; allowedHosts: string[]; allowedOrigins: string[]; log: (l: Record<string, unknown>) => void }): (req: Request) => Promise<{ client: ClientInfo } | Response>` — path `/mcp`, Host, Origin, Bearer, in that order, logging `{t, status, reason}` on rejection (moved verbatim from `http-app.ts`).
  - `mcpHandler(opts: { service: RirService; gate: ClientGate; log; onError? }): { fetch(req: Request, client: ClientInfo): Promise<Response>; close(): Promise<void> }` — `createMcpHandler` with `maxRequestBodySize: 65_536`, `maxSubscriptions: 0`, `responseMode: 'json'`; the factory reads the client from `authInfo` exactly as today.
  - Node `createHttpApp` = `edgeGate` then `mcpHandler.fetch`.

- [ ] **Step 1: Failing test** — `edge.test.ts`: table of requests → status/reason (404 path, 403 Host, 403 Origin, 401 no key, 401 wrong key, pass → `{ client: { clientId: 'default', quotaPerHour: 60 } }`), and log lines carry no header values.
- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** by moving code; `http-app.ts` shrinks to the composition. Core purity test must pass (`@modelcontextprotocol/server` is already a core dependency).
- [ ] **Step 4:** `corepack pnpm test && corepack pnpm typecheck` — node HTTP tests unchanged and green.
- [ ] **Step 5: Commit** — `refactor: move the HTTP edge gate and MCP handler into core`

---

### Task 3: Worker package scaffold

**Files:**
- Create: `packages/worker/package.json`, `packages/worker/wrangler.jsonc`, `packages/worker/tsconfig.json`, `packages/worker/vitest.config.ts`, `packages/worker/src/index.ts` (stub: 404 for everything), `packages/worker/src/state-do.ts` (empty `StateDO extends DurableObject`), `packages/worker/test/smoke.test.ts`
- Modify: root `package.json` (`"test:worker": "pnpm --filter @ieisi/rir-mcp-worker test"`, typecheck runs both projects), root `tsconfig.json` (`include` core and node only), root `vitest.config.ts` (exclude `packages/worker/**`), `pnpm-workspace.yaml` (`allowBuilds: workerd: true`)

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "rir-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "durable_objects": { "bindings": [{ "name": "STATE", "class_name": "StateDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["StateDO"] }],
  "kv_namespaces": [{ "binding": "API_KEYS", "id": "<set-on-deploy>" }],
  "vars": { "OPERATOR": "", "ALLOWED_HOSTS": "", "ALLOWED_ORIGINS": "" },
  "observability": { "enabled": true }
}
```

(Test config overrides `vars` and uses a local KV; `API_KEY` comes from `.dev.vars` or test bindings, never committed.)

`package.json` devDependencies: `wrangler@^4.147`, `@cloudflare/vitest-plugin@^1.3.6`, `vitest@^4.1`, `@cloudflare/workers-types` via `wrangler types` output committed as `worker-configuration.d.ts`; dependencies: `@ieisi/rir-mcp-core: workspace:*`, `@modelcontextprotocol/server`.

- [ ] **Step 1: Failing test** — `smoke.test.ts`: `exports.default.fetch(new Request('https://x/'))` → 404; `env.STATE` is a namespace.
- [ ] **Step 2: Run** `corepack pnpm test:worker` — FAIL (no package).
- [ ] **Step 3: Implement** scaffold; `corepack pnpm install`; generate types (`wrangler types`).
- [ ] **Step 4:** `corepack pnpm test`, `corepack pnpm test:worker`, `corepack pnpm typecheck` all green.
- [ ] **Step 5: Commit** — `build(worker): scaffold the Cloudflare Worker package`

---

### Task 4: SQLite-backed state map and cache (worker)

**Files:**
- Create: `packages/worker/src/sql-store.ts`
- Test: `packages/worker/test/sql-store.test.ts` (inside the DO via `runInDurableObject`)

**Interfaces:**
- Produces:
  - `class SqlStateMap<V> implements StateMap<V> { constructor(sql: SqlStorage, table: string) }` — table `(key TEXT PRIMARY KEY, value TEXT NOT NULL)`, JSON values, `INSERT … ON CONFLICT DO UPDATE` on `set`.
  - `class SqlCache implements CacheStore { constructor(sql: SqlStorage, clock: Clock, limits?: { maxEntries?: number; maxBytes?: number }) }` — table `cache(key TEXT PRIMARY KEY, value TEXT, bytes INTEGER, fetched_at, fresh_until, stale_until, used_at INTEGER)`; `get` returns null when absent or `now >= stale_until` and bumps `used_at`; `put` upserts then evicts least-recently-used rows while `count > maxEntries` (default 10,000) or `sum(bytes) > maxBytes` (default 50 MB); a single value over `maxBytes / 100` is not stored.
  - `createTables(sql)` — idempotent `CREATE TABLE IF NOT EXISTS` for `cache`, `limiter`, `gate`, `meta`.

- [ ] **Step 1: Failing tests** — round-trip; expiry; LRU eviction by count and by bytes; oversize value skipped; **eviction survival** (Review Focus 3): put state, `evictDurableObject(stub)`, read it back unchanged.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (synchronous `sql.exec`; no `await` between read and write).
- [ ] **Step 4:** `corepack pnpm test:worker && corepack pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(worker): add SQLite-backed state map and bounded cache`

---

### Task 5: StateDO runs the MCP handler (worker)

**Files:**
- Modify: `packages/worker/src/state-do.ts`
- Test: `packages/worker/test/state-do.test.ts`

**Interfaces:**
- Consumes: `SqlStateMap`, `SqlCache`, `createTables` (Task 4); `MemoryRateLimiter`, `MemoryClientGate` with `state`/`salt` (Task 1); `mcpHandler` (Task 2).
- Produces: `class StateDO extends DurableObject<Env>` with
  - `serve(request: Request, client: ClientInfo): Promise<Response>` (RPC),
  - `upstream: FetchLike` (defaults to `globalThis.fetch`; tests replace it inside `runInDurableObject` — the Vitest plugin documents no outbound fetch mocking),
  - constructor: `blockConcurrencyWhile` → `createTables`, load or create a persisted salt in `meta`, build `RirService({ fetch: (u, i) => this.upstream(u, i), cache: SqlCache, limiter: MemoryRateLimiter(DEFAULT_LIMITS, systemClock, SqlStateMap('limiter')), clock: systemClock, userAgent: buildUserAgent(env.OPERATOR) })`, `MemoryClientGate(systemClock, { state: SqlStateMap('gate'), salt, onSuspend })`, and one `mcpHandler`.
- Logging: `console.log(JSON.stringify(line))` (Workers observability); same value-free fields as Node.

- [ ] **Step 1: Failing tests** — inside `runInDurableObject`: set `upstream` to a fixture fetch (reuse `packages/core/test/support/fake-fetch.ts` + fixtures; import across packages as node tests do); `serve(initialize)` → 200; `serve(tools/call rdap_ip_lookup 1.1.1.1)` → text contains `APNIC`; quota of 1 then a second upstream lookup → `quota_exceeded`, and the cached one still answers; quota state survives `evictDurableObject`.
- [ ] **Step 2–4:** run (FAIL) → implement → `test:worker` + typecheck green.
- [ ] **Step 5: Commit** — `feat(worker): run the MCP handler inside a SQLite-backed Durable Object`

---

### Task 6: KV key store (worker)

**Files:**
- Create: `packages/worker/src/kv-keys.ts`
- Test: `packages/worker/test/kv-keys.test.ts`

**Interfaces:**
- Produces: `class KvKeyStore implements KeyStore { constructor(kv: KVNamespace) }` — `verify(key)`: reject non-`KEY_RE` keys without a KV read; `kv.get(sha256Hex(key), { type: 'text', cacheTtl: 60 })`; parse with `parseKeyRecords([{ sha256: hash, ...JSON.parse(text) }])` inside `try` (any failure → `null`); `revoked` → `null`.

- [ ] **Step 1: Failing tests** (Review Focus 2) — valid record → client; unknown key → null; revoked → null; malformed JSON, missing quota, `quotaPerHour: 0`, `clientId: "Jane Smith"` → null (never throws); a non-key string → null with zero KV reads.
- [ ] **Step 2–4:** run (FAIL) → implement → green.
- [ ] **Step 5: Commit** — `feat(worker): look up API keys in KV`

---

### Task 7: Worker entry — config, fail closed, edge gate, forward to the DO (worker)

**Files:**
- Modify: `packages/worker/src/index.ts`
- Create: `packages/worker/src/config.ts`
- Test: `packages/worker/test/worker.test.ts`

**Interfaces:**
- `loadWorkerConfig(env: Env): { keyStore: KeyStore; allowedHosts: string[]; allowedOrigins: string[] } | { error: string }` — per-user (`API_KEYS` binding present **and** env var `KEYS_MODE=kv`) over single (`API_KEY` secret); missing `OPERATOR`, `ALLOWED_HOSTS`, or both key sources → `{ error }`. Allow-list entries validated as bare hostnames (same rule as Node; move `BARE_HOST` to core `http/edge.ts` in this task and reuse it in Node).
- `fetch(req, env)`: config error → 503 `{"error":"not_configured"}` + one log line; else `edgeGate` → rejection response, or `env.STATE.getByName('state').serve(req, client)`.

(The `KEYS_MODE` switch exists because a KV binding is always declared in `wrangler.jsonc`; precedence = "per-user when the operator says so", which keeps single-key deployments from silently trusting an empty namespace.)

- [ ] **Step 1: Failing tests** — through `exports.default.fetch`: 503 for each missing setting (Review Focus 5) and `listDurableObjectIds(env.STATE)` stays empty; 401 without key and still no DO (Review Focus 1); 403 foreign Origin; valid single key → `initialize` 200 and DO exists; per-user mode with a KV record seeded via `env.API_KEYS.put`; revoked record → 401.
- [ ] **Step 2–4:** run (FAIL) → implement → `test:worker`, `test`, typecheck green.
- [ ] **Step 5: Commit** — `feat(worker): authenticate at the edge and forward to the StateDO`

---

### Task 8: Key tool for KV, docs, spec amendment

**Files:**
- Modify: `scripts/keys.ts` (`new … --target kv` prints the `wrangler kv key put --binding API_KEYS --remote <hash> '<json>'` command instead of a keys-file line; `revoke <key> --target kv` prints the command that rewrites the record with `revoked: true`; no network calls), its tests in `packages/node/test/cli.test.ts`
- Modify: `docs/deployment.md` (Cloudflare section: create KV namespace, set id, `wrangler secret put API_KEY` or `KEYS_MODE=kv`, vars, `wrangler deploy` — commands for the operator to run, Q11), spec §3/§6 (DO as the server, Q9), `docs/superpowers/plans/2026-09-30-rir-mcp-plan-1-followups.md`

- [ ] **Step 1: Failing tests** for the `--target kv` output (command shape, JSON parses with `parseKeyRecords`, key never in the command line it prints).
- [ ] **Step 2–4:** run (FAIL) → implement → all suites green.
- [ ] **Step 5: Commit** — `feat: KV key commands and Cloudflare deployment docs`

---

## Self-review notes

- Spec §6 backends (Worker: StateDO SQLite for cache, limiter, quotas, scan counters) → Tasks 4–5. Spec §7 Cloudflare auth → Tasks 6–7. Deny-list → deferred (Q10). Spec §9 "Worker: StateDO via Cloudflare's Vitest plugin" → Tasks 3–7.
- Audit 2026-10-03 #4 (byte-bounded cache) is resolved for the Worker by `SqlCache` (Task 4); Node's `MemoryCache` keeps its follow-up.
- Audit #5 (fixed windows) unchanged: same algorithm on both runtimes, still a follow-up.
