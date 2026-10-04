import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_RE, parseKeyRecords, sha256Hex } from '@ieisi/rir-mcp-core';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(TSX, [join(ROOT, script), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000 });

describe('rir-mcp CLI', () => {
  it('rejects an unknown mode with usage on stderr, exit 2, and nothing on stdout', () => {
    const r = run('packages/node/src/cli.ts', ['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage:');
    expect(r.stdout).toBe('');
  });

  it('dispatches --http to the HTTP entry (which refuses to start without a key)', () => {
    const r = run('packages/node/src/cli.ts', ['--http'], { RIR_MCP_OPERATOR: 'noc@example.net' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to start without authentication');
    expect(r.stdout).toBe('');
  });
});

describe('scripts/keys.ts', () => {
  it('new prints a key, then a keys-file record that matches it', async () => {
    const r = run('scripts/keys.ts', ['new', 'acme-noc', '120']);
    expect(r.status).toBe(0);
    const [key, json] = r.stdout.trim().split('\n');
    expect(key).toMatch(KEY_RE);
    const [rec] = parseKeyRecords([JSON.parse(json ?? '')]);
    expect(rec).toMatchObject({ clientId: 'acme-noc', quotaPerHour: 120, sha256: await sha256Hex(key ?? '') });
  });

  it('new --raw prints only a key', () => {
    const r = run('scripts/keys.ts', ['new', '--raw']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(KEY_RE);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('hash prints the SHA-256 of a key', async () => {
    const key = `rirmcp_${'A'.repeat(43)}`;
    const r = run('scripts/keys.ts', ['hash', key]);
    expect(r.stdout.trim()).toBe(await sha256Hex(key));
  });

  it('new --target kv prints a key, then a wrangler command that stores its record and never contains the key', async () => {
    const r = run('scripts/keys.ts', ['new', 'acme-noc', '120', '--target', 'kv']);
    expect(r.status).toBe(0);
    const [key = '', command = ''] = r.stdout.trim().split('\n');
    expect(key).toMatch(KEY_RE);
    const m = /^npx wrangler kv key put ([0-9a-f]{64}) '(\{[^']*\})' --binding API_KEYS --remote$/.exec(command);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(await sha256Hex(key));
    const [rec] = parseKeyRecords([{ ...JSON.parse(m?.[2] ?? ''), sha256: m?.[1] }]);
    expect(rec).toMatchObject({ clientId: 'acme-noc', quotaPerHour: 120 });
    expect(command).not.toContain(key);
    expect(command).not.toContain('rirmcp_');
  });

  it('revoke --target kv prints the delete command for a key or for its hash', async () => {
    const key = `rirmcp_${'A'.repeat(43)}`;
    const hash = await sha256Hex(key);
    const expected = `npx wrangler kv key delete ${hash} --binding API_KEYS --remote`;
    for (const arg of [key, hash]) {
      const r = run('scripts/keys.ts', ['revoke', arg, '--target', 'kv']);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(expected);
    }
  });

  it.each([
    ['a clientId that is not opaque', ['new', 'Jane Smith']],
    ['a bad quota', ['new', 'acme', '0']],
    ['hash of a malformed key', ['hash', 'nope']],
    ['no command', []],
    ['an unknown target', ['new', 'acme', '--target', 'd1']],
    ['revoke without --target kv', ['revoke', `rirmcp_${'A'.repeat(43)}`]],
    ['revoke of something that is neither a key nor a hash', ['revoke', 'acme', '--target', 'kv']],
    ['new --raw --target kv (single keys are a wrangler secret)', ['new', '--raw', '--target', 'kv']],
  ])('rejects %s with exit 2 and no key on stdout', (_name, args) => {
    const r = run('scripts/keys.ts', args);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('usage:');
  });
});
