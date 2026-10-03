#!/usr/bin/env node
// rir-mcp [--stdio | --http]: stdio is the default (local MCP clients); --http serves Streamable HTTP.
export {};

const USAGE = 'usage: rir-mcp [--stdio | --http]   (configuration via RIR_MCP_* environment variables; see docs/deployment.md)';

const args = process.argv.slice(2);
const mode = args.length === 0 ? '--stdio' : args.length === 1 ? args[0] : undefined;

if (mode === '--stdio') await import('./stdio');
else if (mode === '--http') await import('./http');
else {
  // stdout may be an MCP client's protocol pipe: diagnostics only ever go to stderr.
  console.error(USAGE);
  process.exit(2);
}
