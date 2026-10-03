import { DEFAULT_LIMITS, MemoryCache, MemoryClientGate, MemoryRateLimiter, RirService, SingleKeyStore } from '@ieisi/rir-mcp-core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http-app';
import { startHttp } from '../src/http-bridge';
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

beforeAll(async () => {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    'https://rdap.apnic.net/ip/1.1.1.1': { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
  });
  const service = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
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
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...POST_HEADERS, authorization: `Bearer ${KEY}` }, body: big });
    expect(res.status).toBe(413);
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
});
