# rir-mcp

An MCP server that answers registry questions about IP addresses, prefixes, AS numbers, organisations and reverse DNS, using RDAP data from the five Regional Internet Registries (APNIC, ARIN, RIPE NCC, LACNIC, AFRINIC), plus APNIC registration history (whowas).

- Compact answers: typically ~300 bytes instead of 4–250 KB of raw RDAP JSON.
- No personal data: contacts of individual people are never returned or stored.
- Polite to the registries: per-RIR rate limits, caching, and a User-Agent that names the operator.

Status: early development (Plan 1 of 4: local stdio server). Design: `docs/superpowers/specs/2026-09-30-rir-mcp-core-design.md`.

## Run locally with Claude Code

Requires Node 22+ and pnpm (via Corepack).

```bash
git clone https://github.com/IEISI-ORG/rir-mcp && cd rir-mcp
corepack pnpm install
claude mcp add rir-mcp -s user -e RIR_MCP_OPERATOR='noc@your-domain.example' -- \
  "$PWD/node_modules/.bin/tsx" "$PWD/packages/node/src/stdio.ts"
```

`RIR_MCP_OPERATOR` is required: a contact email or URL for whoever runs the server. It is sent to the registries in the User-Agent.

Then ask, for example: "Who holds 1.1.1.1?", "Who is AS4608?", "What's the history of 1.1.1.1?".

See [docs/deployment.md](docs/deployment.md) for installation, configuration and troubleshooting.

## Tests

```bash
corepack pnpm test                                                                   # offline, uses recorded fixtures
RIR_MCP_OPERATOR='https://your-tracker.example/issues' corepack pnpm test:live       # one live query per RIR
```

## Terms of Use

Use is subject to the rir-mcp Terms of Use (to be published): no marketing to, spamming or harassment of RIR members.
