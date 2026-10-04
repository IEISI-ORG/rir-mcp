# Deploying rir-mcp

## Deployment modes

| Mode | Status |
|------|--------|
| Local stdio (Claude Code / Claude Desktop) | Available |
| Self-hosted HTTP (Streamable HTTP, API keys) | Available |
| Docker image | Not yet available (Plan 4) |
| Cloudflare Workers (edge Worker + one Durable Object, API keys) | Available; tested locally in workerd, not yet run on a live account |

All three available modes run from a clone of this repository (see *Install and verify*). They share the rate limits and privacy rules described below; the Cloudflare section lists where it differs.

## Prerequisites

- Node 22 or newer (tested on Node 24)
- git
- pnpm through Corepack: run every pnpm command as `corepack pnpm ...`. No global pnpm install is needed.

## Install and verify

```bash
git clone https://github.com/IEISI-ORG/rir-mcp && cd rir-mcp
corepack pnpm install
corepack pnpm test
```

`corepack pnpm test` is offline. It runs against recorded fixtures.

## Operator contact (`RIR_MCP_OPERATOR`)

`RIR_MCP_OPERATOR` names whoever runs the server. It is sent to the registries in the User-Agent (`rir-mcp/<version> (+https://github.com/IEISI-ORG/rir-mcp; operator=<contact>)`) so an RIR can reach you if your server causes a problem. The server refuses to start without it.

Format rules:

- a single line of printable ASCII only,
- no parentheses or semicolons,
- at most 200 characters.

Use a role mailbox (for example `noc@example.net`) or an issue-tracker URL rather than a personal address.

## Claude Code

```bash
claude mcp add rir-mcp -s user -e RIR_MCP_OPERATOR='noc@your-domain.example' -- \
  "$PWD/node_modules/.bin/tsx" "$PWD/packages/node/src/stdio.ts"
```

Run this from the repository root. `-s` sets the scope (`local`, `user` or `project`); `-e KEY=value` sets an environment variable for the server.

Launch the server through `tsx` directly, not through `pnpm run`. pnpm writes its own lines to stdout, and stdout carries the MCP protocol, so any extra output corrupts the connection.

## Claude Desktop

Add an entry under `mcpServers` in `claude_desktop_config.json`, using absolute paths:

```json
{
  "mcpServers": {
    "rir-mcp": {
      "command": "/absolute/path/to/rir-mcp/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/rir-mcp/packages/node/src/stdio.ts"],
      "env": { "RIR_MCP_OPERATOR": "noc@your-domain.example" }
    }
  }
}
```

Restart Claude Desktop after editing the file.

`node_modules/.bin/tsx` starts with `#!/usr/bin/env node`, so the app that launches it must find `node` on its PATH. GUI launchers often do not see nvm or similar. Either:

- set `"command"` to the absolute path of `node` and put the tsx CLI first in `args`:

  ```json
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/rir-mcp/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/rir-mcp/packages/node/src/stdio.ts"]
  ```

- or add the directory that holds `node` to `env.PATH`.

## Self-hosted HTTP

The HTTP mode serves the same five tools over MCP Streamable HTTP at `/mcp`, for clients that cannot launch a local process or for a team sharing one server. Every request needs an API key.

### Start it

```bash
export RIR_MCP_OPERATOR='noc@example.net'
export RIR_MCP_API_KEY="$(node_modules/.bin/tsx scripts/keys.ts new --raw)"   # single-key mode, see below
node_modules/.bin/tsx packages/node/src/cli.ts --http
# rir-mcp: listening on http://127.0.0.1:4608/mcp (auth: single)
```

Print the key with `echo "$RIR_MCP_API_KEY"` and give it to the client. `cli.ts --stdio` (the default) starts the stdio mode instead.

### API keys

Keys look like `rirmcp_` followed by 43 characters. The server stores only their SHA-256 hashes. It refuses to start with no key source configured. Choose one mode:

| Mode | Configure | Client id in logs | Quota |
|------|-----------|-------------------|-------|
| Per-user keys (takes precedence) | `RIR_MCP_KEYS_FILE=/path/keys.json` | from the record | per record |
| Single key | `RIR_MCP_API_KEY=rirmcp_...` | `default` | `RIR_MCP_QUOTA_PER_HOUR` (default 60) |

Per-user mode: create each client's key with

```bash
node_modules/.bin/tsx scripts/keys.ts new acme-noc 60
# line 1: the key, give it to the client (shown once, never stored)
# line 2: {"sha256":"...","clientId":"acme-noc","quotaPerHour":60}, add it to the keys file
```

The keys file is a JSON array of those records. `clientId` must be an opaque id (`^[a-z0-9][a-z0-9-]{0,31}$`), never a person's name or email, because it appears in logs. To revoke a key, set `"revoked": true` on its record or delete the record. `scripts/keys.ts hash <key>` prints a key's hash so you can find its record.

The server re-reads the keys file at most every 30 seconds, so additions and revocations take effect within 30 seconds without a restart. If the file becomes unreadable or invalid, **every key is rejected** until it is fixed, and one error line is logged. This makes a broken edit fail closed, never leaving old keys live.

### Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `RIR_MCP_OPERATOR` | (required) | Operator contact, as for stdio |
| `RIR_MCP_KEYS_FILE` | — | Per-user keys file (see above) |
| `RIR_MCP_API_KEY` | — | Single key (see above) |
| `RIR_MCP_QUOTA_PER_HOUR` | `60` | Single-key quota: upstream lookups per hour |
| `RIR_MCP_HTTP_HOST` | `127.0.0.1` | Bind address |
| `RIR_MCP_HTTP_PORT` | `4608` | Port (IANA-unassigned; also APNIC's AS number) |
| `RIR_MCP_ALLOWED_HOSTS` | `localhost, 127.0.0.1, [::1]` | `Host` header names accepted. **Required** when binding anything other than loopback |
| `RIR_MCP_ALLOWED_ORIGINS` | `localhost, 127.0.0.1, [::1]` | `Origin` hostnames accepted; requests without `Origin` (non-browser clients such as Claude Code) are unaffected. Browser-based clients are not supported yet: the server sends no CORS headers |

Allow-list entries are bare hostnames: `rdap.example.net` or `[::1]`, with no scheme, port or path. The server refuses to start on an entry it could never match.

### Serving beyond localhost

1. Put a TLS-terminating reverse proxy (nginx, Caddy, a load balancer) in front. The server itself speaks plain HTTP.
2. Either keep the server on `127.0.0.1` behind the proxy, or bind it to an internal address with `RIR_MCP_HTTP_HOST`.
3. Set `RIR_MCP_ALLOWED_HOSTS` to the public hostname clients use, e.g. `rdap.example.net`. This blocks DNS-rebinding attacks.

### Connect a client

Claude Code:

```bash
claude mcp add --transport http rir-mcp https://rdap.example.net/mcp --header "Authorization: Bearer rirmcp_..."
```

Check that the server rejects a request without a key:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4608/mcp   # 401
```

### Request handling

Each request is checked in this order: path `/mcp` (else 404), `Host` allow-list (else 403), `Origin` allow-list (else 403), Bearer key (else 401). Request bodies over 64 KiB get 413. Slow clients are cut off after 10 seconds for headers and 30 seconds per request.

### Quotas and scan detection

- **Quota:** each key may make `quotaPerHour` upstream lookups per hour (default 60). Cached answers are free and keep working after the quota is used up. A history lookup costs 5. A reverse-DNS lookup costs 1 however many zones it checks. If the shared per-RIR limit refuses a lookup, the client's unit is refunded.
- **Scan detection:** a key that queries more than 200 distinct /24s, /48s, AS numbers or handles in an hour is suspended for 24 hours. The server logs `{"alert":"client_suspended","client":"<id>"}`. Only salted hashes of what was queried are kept, in memory, to count distinct values. They are reset with the client's hourly window, on its next request after the hour (an idle client's stay in memory until then or until a restart). A restart lifts all suspensions. (On Cloudflare, state persists: see below.)

### Logs

stderr carries one JSON line per tool call and per rejected request, for example:

```
{"t":"2026-10-04T01:02:03.000Z","tool":"rdap_ip_lookup","outcome":"record","rir":"apnic","cache":"miss","ms":412,"client":"acme-noc"}
{"t":"2026-10-04T01:02:04.000Z","status":401,"reason":"unauthorized"}
```

Logs never contain queried values, API keys, `Authorization` headers or registry data. Errors are logged by type only.

## Cloudflare Workers

The Worker serves the same five tools at `https://<your host>/mcp`. Cloudflare runs the edge part close to each client: it checks the path, `Host`, `Origin` and API key there. It then forwards the request to a single Durable Object, which holds the cache, the per-RIR rate limits, the quotas and the scan detector in its own SQLite storage.

Commands below are for you to run against your own Cloudflare account. Nothing in this repository deploys anything. Run them from `packages/worker`; `npx wrangler` uses the copy installed there.

### Set up

```bash
cd packages/worker
npx wrangler login
npx wrangler kv namespace create API_KEYS   # prints the namespace id
```

Edit `wrangler.jsonc`:

- `kv_namespaces[0].id`: the id printed above.
- `vars.OPERATOR`: your operator contact, with the same rules as `RIR_MCP_OPERATOR` (printable ASCII, no parentheses or semicolons, at most 200 characters).
- `vars.ALLOWED_HOSTS`: the hostname clients connect to, for example `rir-mcp.<your-subdomain>.workers.dev` or your custom domain. Bare hostnames only, comma-separated.
- `vars.ALLOWED_ORIGINS`: leave empty. Non-browser clients such as Claude Code send no `Origin` and are unaffected; browser-based clients are not supported yet (no CORS headers).
- `vars.KEYS_MODE`: empty for a single key (quota fixed at 60 lookups per hour for now), `kv` for per-user keys (quota per record).

If any of `OPERATOR`, `ALLOWED_HOSTS` or the key source is missing or invalid, the Worker answers **503** `{"error":"not_configured"}` to every request and logs which setting is wrong (never its value).

### API keys

Single key (`KEYS_MODE` empty): store it as a secret, then give it to the client.

```bash
KEY="$(../../node_modules/.bin/tsx ../../scripts/keys.ts new --raw)"
printf '%s' "$KEY" | npx wrangler secret put API_KEY
echo "$KEY"
```

Per-user keys (`KEYS_MODE` set to `kv`): each key's record lives in the `API_KEYS` namespace under the key's SHA-256. The `API_KEY` secret is ignored in this mode.

```bash
../../node_modules/.bin/tsx ../../scripts/keys.ts new acme-noc 60 --target kv
# line 1: the key, give it to the client (shown once, never stored)
# line 2: a `npx wrangler kv key put <sha256> '{"clientId":"acme-noc","quotaPerHour":60}' ...` command, run it
```

To revoke a key, pass the key or its SHA-256 and run the command it prints:

```bash
../../node_modules/.bin/tsx ../../scripts/keys.ts revoke <key-or-sha256> --target kv
# npx wrangler kv key delete <sha256> --binding API_KEYS --remote
```

KV is cached at the edge for up to 60 seconds, so additions and revocations take effect within about a minute. A record that is malformed (bad JSON, missing or zero quota, a `clientId` that is not an opaque id) is treated as no key.

### Deploy and check

```bash
npx wrangler deploy
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your host>/mcp   # 401
claude mcp add --transport http rir-mcp https://<your host>/mcp --header "Authorization: Bearer rirmcp_..."
```

### How it differs from the Node server

- **State survives restarts and deploys.** Quotas, rate-limit windows and suspensions are stored in the Durable Object, so a 24-hour suspension lasts 24 hours even across a redeploy.
- **Scan detection** keeps salted hashes of queried /24s, /48s, AS numbers and handles for the client's current hour, and at most about an hour after it ends: they are dropped when a client is suspended, and an hourly alarm deletes any left from ended hours.
- **Cache:** at most 10,000 entries and 50 MB, least recently used first out. A single answer over 500 KB is not cached.
- **Logs** go to Workers Logs: the same value-free JSON lines as the Node server's stderr. Cloudflare's own invocation logs are turned off in `wrangler.jsonc`, because they record request headers, including the `Authorization` header that carries the API key. Traces are pinned off too, because they record outbound fetch URLs, which contain the queried address or AS number. Do not turn either back on. `wrangler tail` and Tail Workers receive request headers whatever these settings say: treat a tail session as able to see API keys.
- **One Durable Object** serves every client, so rate limits and request de-duplication are exact worldwide. Requests from far away pay one round trip to its location.

## Checking that it works

Ask your MCP client, for example:

- "Who holds 1.1.1.1?"
- "Who is AS4608?"
- "What's the history of 1.1.1.1?"

To check the five registries directly (five live queries, one per RIR):

```bash
RIR_MCP_OPERATOR='https://your-tracker.example/issues' corepack pnpm test:live
```

## Operations

Per-RIR rate limits (also the maximum):

| RIR | Rate | Burst | Hourly cap |
|-----|------|-------|-----------|
| APNIC | 1 req/s | 5 | none |
| ARIN | 1 req/s | 5 | none |
| RIPE NCC | 1 req/s | 5 | none |
| AFRINIC | 1 req/s | 5 | none |
| LACNIC | 10 req/min | 3 | 1,000 |

Request weights: a current lookup costs 1, a history lookup costs 5. After an upstream 429, 5xx, timeout or bad response, the RIR's rate is halved for 5 minutes.

Cache lifetimes:

| Data | Fresh | Stale |
|------|-------|-------|
| Current record | 1 hour | 24 hours |
| Not found | 15 minutes | 15 minutes |
| History | 7 days | 30 days |
| IANA bootstrap | 24 hours | 7 days |

The cache is in memory, holds up to 10,000 entries, and is lost when the server restarts. When a registry cannot be reached and a stale entry exists, the answer is served and labelled `STALE`.

## Refreshing test fixtures

```bash
RIR_MCP_OPERATOR='https://your-tracker.example/issues' corepack pnpm fixtures:record
corepack pnpm test
```

The recorder makes 19 paced requests. Run `corepack pnpm test` afterwards: the PII lint must pass before you commit new fixtures.

## Troubleshooting

**The server exits at startup with a `RIR_MCP_OPERATOR` message.** Missing operator:

```
rir-mcp: RIR_MCP_OPERATOR is required: a contact email or URL for whoever runs this server. It is sent in the User-Agent so the RIRs can reach you.
```

Set the variable (see the client sections above). An invalid value gives `rir-mcp: RIR_MCP_OPERATOR is invalid: ...`; check the format rules.

**LACNIC or AFRINIC queries time out.** Node's default 250 ms per-address-family connect timeout (Happy Eyeballs) is too short from high-latency locations such as Australia. The stdio entry point already sets `setDefaultAutoSelectFamilyAttemptTimeout(2000)`. If you write your own entry point, set it before the first fetch.

**"Rate limit ... retry in Ns".** The per-RIR limiter is protecting that registry. Wait the stated number of seconds and ask again. Repeated identical questions are served from cache.

**`rir-mcp: internal error (...)` on stderr.** An unexpected error occurred. The line carries only the error's type name, never its message, because messages may contain queried values. The client receives an error answer for that call.

## Privacy and security

- Contacts of individual people are never returned or cached.
- Queried values are never logged.
- stdio mode: stderr carries only the startup line and `internal error (<type>)` lines.
- HTTP mode: stderr carries the startup line and the JSON log lines described under *Logs*; API keys are stored only as SHA-256 hashes.
- Cloudflare: Workers Logs carries the same JSON lines; invocation logs (which record request headers) are off; API keys are stored only as SHA-256 hashes in KV or as a Worker secret.
- Terms of Use: https://github.com/IEISI-ORG/rir-mcp/blob/main/TERMS_OF_USE.md (to be published).
