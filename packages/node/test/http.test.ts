import { connect as tcpConnect } from 'node:net';
import { DEFAULT_LIMITS, MemoryCache, MemoryClientGate, MemoryRateLimiter, RirService, SingleKeyStore } from '@ieisi/rir-mcp-core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/http-app';
import { startHttp, toWebRequest } from '../src/http-bridge';
import { fakeFetch } from '../../core/test/support/fake-fetch';
import { ianaRoutes, loadFixture } from '../../core/test/support/fixtures';
import { FakeClock } from '../../core/test/support/fake-clock';

const KEY = `rirmcp_${'A'.repeat(43)}`;
const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});
const POST_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let base = '';
let close: () => Promise<void> = async () => {};
const logs: Array<Record<string, unknown>> = [];
let service: RirService;

beforeAll(async () => {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    'https://rdap.apnic.net/ip/1.1.1.1': { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
  });
  service = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
  const app = createHttpApp({
    service,
    gate: new MemoryClientGate(clock),
    keyStore: new SingleKeyStore(KEY),
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: ['127.0.0.1', 'localhost'],
    log: (line) => logs.push(line),
  });
  const server = await startHttp({ host: '127.0.0.1', port: 0 }, app);
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
});

afterAll(async () => { await close(); });

const connect = async (key = KEY) => {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
};

describe('Streamable HTTP server', () => {
  it('serves tools to a client with a valid key', async () => {
    const c = await connect();
    expect((await c.listTools()).tools).toHaveLength(5);
    const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    expect(JSON.stringify(r.content)).toContain('APNIC');
    await c.close();
  });

  it.each([
    ['no key', {}, 401],
    ['wrong key', { authorization: `Bearer rirmcp_${'B'.repeat(43)}` }, 401],
    ['a non-Bearer scheme', { authorization: `Basic ${KEY}` }, 401],
    ['foreign origin with a valid key', { authorization: `Bearer ${KEY}`, origin: 'https://evil.example' }, 403],
    ['null origin', { authorization: `Bearer ${KEY}`, origin: 'null' }, 403],
  ])('rejects %s', async (_name, headers, status) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...POST_HEADERS, ...headers }, body: INIT });
    expect(res.status).toBe(status);
  });

  it('rejects a foreign Host header (DNS rebinding) before auth', async () => {
    // fetch() (undici) always sends the real Host, so use node:http to send a forged one.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: 'POST', headers: { ...POST_HEADERS, host: 'evil.example', authorization: `Bearer ${KEY}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(INIT);
    });
    expect(status).toBe(403);
    expect(logs).toContainEqual(expect.objectContaining({ status: 403, reason: 'bad_host' }));
  });

  it('maps absolute-form and protocol-relative request targets to 404', async () => {
    for (const path of ['http://evil.example/mcp', '//evil.example/mcp']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: Number(new URL(base).port), path, method: 'POST', headers: POST_HEADERS }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(INIT);
      });
      expect(status).toBe(404);
    }
  });

  it('returns 404 off /mcp and 413 for an oversized body', async () => {
    expect((await fetch(`${base}/other`)).status).toBe(404);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } });
    const forClient = vi.spyOn(service, 'forClient');
    try {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer ${KEY}` }, body: big });
      expect(res.status).toBe(413);
      expect(forClient).not.toHaveBeenCalled(); // refused before any per-request server was built
      const ok = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer ${KEY}` }, body: INIT });
      expect(ok.status).toBe(200);
      expect(forClient).toHaveBeenCalled(); // the spy does see a normal request
    } finally {
      forClient.mockRestore();
    }
  });

  it('counts every call in a JSON-RPC batch against the per-client call rate', async () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({
      jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } },
    }));
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer ${KEY}`, 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(batch),
    });
    const text = await res.text();
    expect((text.match(/Too many calls for this API key/g) ?? []).length).toBeGreaterThan(30);
  });

  it('logs calls with clientId and rejections with a reason, never query values or keys', async () => {
    const c = await connect();
    await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    await c.close();
    await fetch(`${base}/mcp`, { method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer rirmcp_${'C'.repeat(43)}` }, body: INIT });
    const text = JSON.stringify(logs);
    expect(logs).toContainEqual(expect.objectContaining({ tool: 'rdap_ip_lookup', client: 'default', outcome: 'record' }));
    expect(logs).toContainEqual(expect.objectContaining({ status: 401, reason: 'unauthorized' }));
    expect(text).not.toMatch(/1\.1\.1\.1|rirmcp_|Bearer/);
  });

  it('refuses subscriptions/listen instead of holding an open stream (audit 2026-10-04 #1)', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true }, _meta: {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {}, [CLIENT_INFO_META_KEY]: { name: 'x', version: '0' },
      } },
    });
    const text = await new Promise<string>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: 'POST', headers: {
        ...POST_HEADERS, authorization: `Bearer ${KEY}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen',
      } }, (res) => {
        let out = '';
        res.on('data', (d) => { out += String(d); });
        res.on('end', () => resolve(out));
      });
      req.setTimeout(3_000, () => { req.destroy(); reject(new Error('stream held open')); });
      req.on('error', reject);
      req.end(body);
    });
    expect(text).toContain('Subscription limit');
  });

  it('maps a backslash request target to 404 (audit 2026-10-04 #2)', async () => {
    for (const path of ['/\\evil.example/mcp', '/\\/evil.example/mcp']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: Number(new URL(base).port), path, method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer ${KEY}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(INIT);
      });
      expect(status).toBe(404);
    }
  });
});

describe('toWebRequest', () => {
  it.each(['/\\evil.example/mcp', '//evil.example/mcp', 'http://evil.example/mcp', '/mcp\\..\\x'])('never lets target %j choose the URL host', (target) => {
    const req = toWebRequest({ url: target, method: 'GET', headers: {} } as never);
    expect(new URL(req.url).host).toBe('rir-mcp.invalid');
  });
});

describe('per-key request limit (audit 2026-10-07 L3)', () => {
  it('refuses requests past the burst with 429 and Retry-After, whatever the method, before building a server', async () => {
    const clock = new FakeClock();
    const service = new RirService({ fetch: fakeFetch({}), clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
    const lines: Array<Record<string, unknown>> = [];
    const app = createHttpApp({
      service, gate: new MemoryClientGate(clock, { requestsPerMinute: 60, requestBurst: 4 }), keyStore: new SingleKeyStore(KEY),
      allowedHosts: ['127.0.0.1', 'localhost'], allowedOrigins: ['127.0.0.1', 'localhost'], log: (l) => lines.push(l),
    });
    const server = await startHttp({ host: '127.0.0.1', port: 0 }, app);
    try {
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 8; i++) {
        const method = ['tools/list', 'ping', 'resources/list'][i % 3]!;
        const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer ${KEY}`, 'mcp-protocol-version': '2025-11-25' },
          body: JSON.stringify({ jsonrpc: '2.0', id: i, method }),
        });
        statuses.push(res.status);
        if (res.status === 429) retryAfter = res.headers.get('retry-after');
        await res.text();
      }
      expect(statuses.slice(0, 4).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(4)).toEqual([429, 429, 429, 429]);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      expect(lines).toContainEqual(expect.objectContaining({ status: 429, reason: 'rate', client: 'default' }));
    } finally {
      await server.close();
    }
  });
});

describe('slow request bodies', () => {
  it('answers 408 to a client that trickles its body past the request timeout', async () => {
    const clock = new FakeClock();
    const service = new RirService({ fetch: fakeFetch({}), clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
    const app = createHttpApp({
      service, gate: new MemoryClientGate(clock), keyStore: new SingleKeyStore(KEY),
      allowedHosts: ['127.0.0.1', 'localhost'], allowedOrigins: ['127.0.0.1', 'localhost'], log: () => {},
    });
    const server = await startHttp({ host: '127.0.0.1', port: 0, timeouts: { requestMs: 300, headersMs: 300, checkEveryMs: 50 } }, app);
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const sock = tcpConnect(server.port, '127.0.0.1', () => {
          sock.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${KEY}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
        });
        let data = '';
        sock.on('data', (d) => { data += d.toString(); });
        sock.on('close', () => resolve(data));
        sock.on('error', reject);
        setTimeout(() => { sock.destroy(); resolve(data); }, 3_000);
      });
      expect(reply.split('\r\n')[0]).toContain('408');
    } finally {
      await server.close();
    }
  });
});
