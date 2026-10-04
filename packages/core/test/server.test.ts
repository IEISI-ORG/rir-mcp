import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../src/memory/cache';
import { MemoryRateLimiter } from '../src/memory/rate-limiter';
import { DEFAULT_LIMITS } from '../src/rdap/limits';
import { createServer } from '../src/server';
import { RirService } from '../src/service/service';
import { TOOL_NAMES, type ServerHooks } from '../src/tools';
import { FakeClock } from './support/fake-clock';
import { fakeFetch } from './support/fake-fetch';
import { ianaRoutes, loadFixture } from './support/fixtures';

let client: Client | null = null;
afterEach(async () => { await client?.close(); client = null; });

async function connect(hooks: ServerHooks = {}): Promise<Client> {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    'https://rdap.apnic.net/ip/1.1.1.1': { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    'https://rdap.apnic.net/history/ip/1.1.1.1': { body: loadFixture('rdap/apnic/history-ip/1.1.1.1.json') },
  });
  const service = new RirService({ fetch, clock, userAgent: 'test', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(service, hooks).connect(serverT);
  client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientT);
  return client;
}

const text = (r: { content?: unknown }) => JSON.stringify(r.content);

describe('MCP server', () => {
  it('lists the five tools in a fixed order and serves instructions', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(c.getInstructions()).toContain('Terms of Use');
  });

  it('answers an IP lookup with text and structured content', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('1.1.1.0/24  APNIC-LABS');
    expect(r.structuredContent).toMatchObject({ answer: 'record', rir: 'apnic', cache: 'miss' });
  });

  it.each(['2012-13-45', '2012-02-30', '0000-00-00'])('rejects an impossible history date %s', async (at) => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_history', arguments: { resource: '1.1.1.1', at } });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it('returns isError with an example for bad input', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_asn_lookup', arguments: { asn: 'AS-FOO' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('AS4608');
  });

  it('reports each call to onCall without the query value', async () => {
    const logs: unknown[] = [];
    const c = await connect({ onCall: (l) => logs.push(l) });
    await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    await c.callTool({ name: 'rdap_asn_lookup', arguments: { asn: 'AS-FOO' } });
    await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '192.168.1.1' } });
    expect(logs).toMatchObject([
      { tool: 'rdap_ip_lookup', outcome: 'record', rir: 'apnic', cache: 'miss' },
      { tool: 'rdap_ip_lookup', outcome: 'record', rir: 'apnic', cache: 'hit' },
      { tool: 'rdap_asn_lookup', outcome: 'invalid_input' },
      { tool: 'rdap_ip_lookup', outcome: 'special' },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/1\.1\.1|192\.168|AS-FOO/);
    for (const l of logs) expect(typeof (l as { ms: number }).ms).toBe('number');
  });

  it('reports history calls through the same hook', async () => {
    const logs: unknown[] = [];
    const c = await connect({ onCall: (l) => logs.push(l) });
    await c.callTool({ name: 'rdap_history', arguments: { resource: '1.1.1.1' } });
    expect(logs).toMatchObject([{ tool: 'rdap_history', outcome: 'record', rir: 'apnic', cache: 'miss' }]);
    expect(JSON.stringify(logs)).not.toMatch(/1\.1\.1/);
  });

  it('keeps answering when the onCall hook throws', async () => {
    const logs: unknown[] = [];
    const c = await connect({ onCall: (l) => { logs.push(l); throw new Error('hook broke'); }, onError: () => {} });
    const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    expect(r.isError).toBeFalsy();
    expect(logs).toHaveLength(1);
  });

  it('logs an unexpected service failure as outcome "internal"', async () => {
    const logs: unknown[] = [];
    const broken = { ip: async () => { throw new TypeError('boom 1.1.1.1'); } } as unknown as RirService;
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createServer(broken, { onCall: (l) => logs.push(l), onError: () => {} }).connect(serverT);
    client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(clientT);
    const r = await client.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    expect(r.isError).toBe(true);
    expect(logs).toMatchObject([{ tool: 'rdap_ip_lookup', outcome: 'internal' }]);
  });

  it('answers special-purpose space as a special answer', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '192.168.1.1' } });
    expect(r.structuredContent).toMatchObject({ answer: 'special' });
  });

  it('answers point-in-time whowas', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_history', arguments: { resource: '1.1.1.1', at: '2012-01-01' } });
    expect(text(r)).toContain('Debogon-prefix');
  });

  it('serves the usage guide resource', async () => {
    const c = await connect();
    const r = await c.readResource({ uri: 'guide://usage' });
    expect(JSON.stringify(r.contents)).toContain('rdap_ip_lookup');
  });

  it('bounds rdap_history structured output to what the text shows', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_history', arguments: { resource: '1.1.1.1', at: '2012-01-01' } });
    expect((r.structuredContent as { data: { mode: string } }).data.mode).toBe('at');
    const json = JSON.stringify(r.structuredContent);
    for (const leak of ['validatedFor', 'latestFrom', 'states']) expect(json).not.toContain(leak);
  });

  it('never leaks internal errors and reports them to the hook', async () => {
    const err = new Error('secret path /x');
    const stub = { ip: () => Promise.reject(err) } as unknown as RirService;
    const onError = vi.fn();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createServer(stub, { onError }).connect(serverT);
    client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(clientT);
    const r = await client.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('secret');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });
});
