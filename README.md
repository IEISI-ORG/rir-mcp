# rir-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant answer Internet registry questions — who holds an IP address or AS number, where to report abuse, which nameservers serve a reverse-DNS zone, and how a registration changed over time — using RDAP data from all five Regional Internet Registries: APNIC, ARIN, RIPE NCC, LACNIC and AFRINIC.

Ask "Who holds 1.1.1.1?" and the assistant gets this, instead of 4–250 KB of raw RDAP JSON:

```text
network   1.1.1.0/24  APNIC-LABS  (AU, ASSIGNED PORTABLE, active)
holder    APNIC Research and Development  [ORG-ARAD1-AP]
abuse     helpdesk@apnic.net  [IRT-APNICRANDNET-AU]
tech      research@apnic.net  [AIC3-AP]
dates     registered 2011-08-10, changed 2023-04-26
source    APNIC RDAP, fetched just now
```

## Why use it

- **Authoritative.** Each query goes to the RIR that manages the resource, found from IANA's bootstrap registry, and the answer names its source.
- **Compact.** A typical answer is about 300 bytes, so it costs few tokens and leaves room in the conversation.
- **No personal data.** Contact details of individual people are never returned, cached or logged: the answer says "personal contact, not disclosed" instead. Role and organisation contacts, such as abuse mailboxes, are shown.
- **Polite to the registries.** Per-RIR rate limits (as low as 10 requests a minute for LACNIC), caching, request de-duplication, and a User-Agent that names whoever runs the server.
- **Safe with untrusted text.** Registry free-text is cleaned of control and invisible characters before it reaches the model.

## Tools

| Tool | Answers | Example question |
|------|---------|------------------|
| `rdap_ip_lookup` | Holder, range, country, status, abuse contact and dates for an IPv4/IPv6 address or prefix | "Where do I report abuse from 8.8.8.8?" |
| `rdap_asn_lookup` | Holder, country, abuse contact and dates for an AS number | "Who is AS4608?" |
| `rdap_entity_lookup` | An organisation or role handle seen in another answer | "What is ORG-ARAD1-AP?" |
| `rdap_reverse_dns` | The registered reverse-DNS zone, its nameservers and DNSSEC status | "What are the reverse DNS servers for 1.1.1.1?" |
| `rdap_history` | How a registration changed, or who held a resource on a date (APNIC only) | "Who held 1.1.1.1 on 2012-01-01?" |

The server deliberately does not search, list or bulk-query the registries, show routing (BGP) data, or query live DNS. On the shared HTTP server, a client that walks address space is suspended for 24 hours.

## Quick start: Claude Code (local)

Requires Node 22 or newer and git. pnpm comes through Corepack; no global install is needed.

```bash
git clone https://github.com/IEISI-ORG/rir-mcp && cd rir-mcp
corepack pnpm install
claude mcp add rir-mcp -s user -e RIR_MCP_OPERATOR='noc@your-domain.example' -- \
  "$PWD/node_modules/.bin/tsx" "$PWD/packages/node/src/stdio.ts"
```

`RIR_MCP_OPERATOR` is required. It is a contact email or URL for whoever runs the server, and it is sent to the registries so they can reach you. Use a role mailbox or an issue-tracker URL, not a personal address.

Claude Desktop setup is in [docs/deployment.md](docs/deployment.md#claude-desktop).

## Quick start: shared HTTP server

The same tools are available over MCP Streamable HTTP for a team or for clients that cannot launch a local process. Every request needs an API key.

```bash
export RIR_MCP_OPERATOR='noc@example.net'
export RIR_MCP_API_KEY="$(node_modules/.bin/tsx scripts/keys.ts new --raw)"
node_modules/.bin/tsx packages/node/src/cli.ts --http
# rir-mcp: listening on http://127.0.0.1:4608/mcp (auth: single)

claude mcp add --transport http rir-mcp http://127.0.0.1:4608/mcp --header "Authorization: Bearer $RIR_MCP_API_KEY"
```

Per-user keys with hourly quotas, revocation, Host/Origin allow-lists and serving beyond localhost are covered in [docs/deployment.md](docs/deployment.md#self-hosted-http).

## Status

Early development. Interfaces and output may still change.

| Mode | Status |
|------|--------|
| Local stdio (Claude Code, Claude Desktop) | Available |
| Self-hosted HTTP with API keys | Available |
| Cloudflare Workers | In progress |
| Docker image, npm package | Planned |

## Development

```bash
corepack pnpm test           # offline, against recorded RDAP fixtures
corepack pnpm test:worker    # Cloudflare Worker package, in workerd
corepack pnpm typecheck
RIR_MCP_OPERATOR='https://your-tracker.example/issues' corepack pnpm test:live   # one live query per RIR
```

| Package | Contents |
|---------|----------|
| `packages/core` | Runtime-neutral server: RDAP client, reducers, rendering, rate limits, auth. No Node or Cloudflare imports. |
| `packages/node` | stdio and HTTP entry points for Node. |
| `packages/worker` | Cloudflare Worker and Durable Object (in progress). |

The design is in [docs/superpowers/specs/](docs/superpowers/specs/2026-09-30-rir-mcp-core-design.md) and the implementation plans are in [docs/superpowers/plans/](docs/superpowers/plans/).

## Issues

Report bugs and registry problems at <https://github.com/IEISI-ORG/rir-mcp/issues>. Please don't include personal data from RDAP records in reports.

## Licence and terms of use

A licence and Terms of Use are being prepared. Until a `LICENSE` file is published here, no licence is granted to use, copy or modify this code. The terms will prohibit using the service for marketing to, spamming or harassing RIR members.
