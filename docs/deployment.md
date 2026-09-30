# Deploying rir-mcp

## Deployment modes

| Mode | Status |
|------|--------|
| Local stdio (Claude Code / Claude Desktop) | Available |
| Self-hosted HTTP / Docker | Not yet available (Plan 2) |
| Cloudflare Workers | Not yet available (Plan 3) |

This document covers only the local stdio mode.

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

- a single line,
- no parentheses,
- at most 200 characters.

Use a role mailbox (for example `noc@example.net`) or an issue-tracker URL rather than a personal address.

## Claude Code

```bash
claude mcp add rir-mcp -s user -e RIR_MCP_OPERATOR=you@example.net -- \
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
      "env": { "RIR_MCP_OPERATOR": "you@example.net" }
    }
  }
}
```

Restart Claude Desktop after editing the file.

## Checking that it works

Ask your MCP client, for example:

- "Who holds 1.1.1.1?"
- "Who is AS4608?"
- "What's the history of 1.1.1.1?"

To check the five registries directly (five live queries, one per RIR):

```bash
RIR_MCP_OPERATOR=https://github.com/you/rir-mcp/issues corepack pnpm test:live
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
RIR_MCP_OPERATOR=https://github.com/you/rir-mcp/issues corepack pnpm fixtures:record
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
- stderr carries only the startup line and `internal error (<type>)` lines.
- Terms of Use: https://github.com/IEISI-ORG/rir-mcp/blob/main/TERMS_OF_USE.md (to be published).
