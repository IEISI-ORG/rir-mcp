import { env } from 'cloudflare:workers';
import { listDurableObjectIds } from 'cloudflare:test';
import { generateKey, sha256Hex } from '@ieisi/rir-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const TEST_KEY = `rirmcp_${'T'.repeat(43)}`; // the API_KEY binding in vitest.config.ts

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

function req(headers: Record<string, string> = {}, path = '/mcp'): Request {
  return new Request(`https://mcp.example.net${path}`, {
    method: 'POST',
    headers: { host: 'mcp.example.net', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: INIT,
  });
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
type TestEnv = Env & { API_KEY?: string };
const call = (r: Request, e: TestEnv = env as TestEnv) => worker.fetch(r as Parameters<typeof worker.fetch>[0], e);
const doCount = async () => (await listDurableObjectIds(env.STATE)).length;

describe('Worker entry: fail closed on missing configuration (Review Focus 5)', () => {
  it.each([
    ['OPERATOR missing', { OPERATOR: '' }],
    ['OPERATOR invalid (parentheses)', { OPERATOR: 'noc (ops)' }],
    ['ALLOWED_HOSTS missing', { ALLOWED_HOSTS: '' }],
    ['ALLOWED_HOSTS not a bare hostname', { ALLOWED_HOSTS: 'https://mcp.example.net' }],
    ['ALLOWED_ORIGINS not a bare hostname', { ALLOWED_ORIGINS: 'app.example.net:443' }],
    ['no key source', { API_KEY: undefined, KEYS_MODE: '' }],
    ['KEYS_MODE kv without the API_KEYS binding', { KEYS_MODE: 'kv', API_KEYS: undefined }],
    ['an unknown KEYS_MODE', { KEYS_MODE: 'KV ' }],
    ['a malformed API_KEY', { API_KEY: 'secret' }],
  ])('%s → 503 not_configured, one log line, no DO', async (_name, override) => {
    const before = await doCount();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    let res: Response;
    try {
      res = await call(req(bearer(TEST_KEY)), { ...(env as TestEnv), ...override } as TestEnv);
      lines = spy.mock.calls.map((a) => a.map(String).join(' '));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_configured' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ status: 503, reason: 'not_configured' });
    expect(lines.join('')).not.toContain('noc (ops)');
    expect(await doCount()).toBe(before);
  });
});

describe('Worker entry: edge checks before the DO (Review Focus 1)', () => {
  it('rejects a request without a key with 401 and creates no DO', async () => {
    const before = await doCount();
    expect((await call(req())).status).toBe(401);
    expect((await call(req(bearer(generateKey())))).status).toBe(401);
    expect(await doCount()).toBe(before);
  });

  it('rejects a foreign Origin and a foreign Host with 403 and creates no DO', async () => {
    const before = await doCount();
    expect((await call(req({ ...bearer(TEST_KEY), origin: 'https://evil.example' }))).status).toBe(403);
    expect((await call(req({ ...bearer(TEST_KEY), host: 'evil.example' }))).status).toBe(403);
    expect(await doCount()).toBe(before);
  });

  it('answers 500 logged as auth_error when KV fails, and creates no DO', async () => {
    const before = await doCount();
    const brokenKv = { get: () => Promise.reject(new Error('KV unavailable')) } as unknown as KVNamespace;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    let res: Response;
    try {
      res = await call(req(bearer(generateKey())), { ...(env as TestEnv), KEYS_MODE: 'kv', API_KEYS: brokenKv } as TestEnv);
      lines = spy.mock.calls.map((a) => a.map(String).join(' '));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ status: 500, reason: 'auth_error' }));
    expect(lines.join('\n')).not.toContain('KV unavailable');
    expect(await doCount()).toBe(before);
  });

  it('matches allow-list entries case-insensitively', async () => {
    const upper = { ...(env as TestEnv), ALLOWED_HOSTS: 'MCP.Example.NET' } as TestEnv;
    expect((await call(req(bearer(TEST_KEY)), upper)).status).toBe(200);
  });

  it('answers 404 off the /mcp path', async () => {
    expect((await call(req(bearer(TEST_KEY), '/other'))).status).toBe(404);
  });
});

describe('Worker entry: forwarding', () => {
  it('serves initialize through the DO with the single API_KEY', async () => {
    const res = await call(req({ ...bearer(TEST_KEY), origin: 'https://app.example.net' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('rir-mcp');
    expect(await doCount()).toBeGreaterThan(0);
  });

  it('uses per-user KV keys when KEYS_MODE is kv, and ignores API_KEY then', async () => {
    const key = generateKey();
    await env.API_KEYS.put(await sha256Hex(key), JSON.stringify({ clientId: 'acme-noc', quotaPerHour: 60 }));
    const kvEnv = { ...(env as TestEnv), KEYS_MODE: 'kv' } as TestEnv;
    expect((await call(req(bearer(key)), kvEnv)).status).toBe(200);
    expect((await call(req(bearer(TEST_KEY)), kvEnv)).status).toBe(401);
  });

  it('rejects a revoked KV record with 401', async () => {
    const key = generateKey();
    await env.API_KEYS.put(await sha256Hex(key), JSON.stringify({ clientId: 'gone', quotaPerHour: 60, revoked: true }));
    expect((await call(req(bearer(key)), { ...(env as TestEnv), KEYS_MODE: 'kv' } as TestEnv)).status).toBe(401);
  });

  it('turns a DO failure into a 500 that logs the error type only', async () => {
    const failing = { getByName: () => ({ serve: () => Promise.reject(new TypeError('boom 1.1.1.1')) }) };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    let res: Response;
    try {
      res = await call(req(bearer(TEST_KEY)), { ...(env as TestEnv), STATE: failing } as unknown as TestEnv);
      lines = spy.mock.calls.map((a) => a.map(String).join(' '));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(lines.join('\n')).toContain('TypeError');
    expect(lines.join('\n')).not.toContain('boom');
  });
});
