import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '@ieisi/rir-mcp-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const ENTRY = join(ROOT, 'packages/node/src/stdio.ts');

describe('stdio server', () => {
  it('lists tools and answers special-purpose space without network access', async () => {
    const transport = new StdioClientTransport({
      command: TSX,
      args: [ENTRY],
      env: { PATH: process.env.PATH ?? '', RIR_MCP_OPERATOR: 'test@example.net' },
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      const r = await client.callTool({ name: 'rdap_ip_lookup', arguments: { address: '10.1.2.3' } });
      expect(JSON.stringify(r.content)).toContain('Private-Use (RFC 1918)');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('exits 1 with a clear message when no operator is configured', () => {
    const run = spawnSync(TSX, [ENTRY], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RIR_MCP_OPERATOR');
  }, 30_000);
});
