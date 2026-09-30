import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/memory/cache';
import { MemoryRateLimiter } from '../src/memory/rate-limiter';
import { DEFAULT_LIMITS } from '../src/rdap/limits';
import { createServer } from '../src/server';
import { RirService } from '../src/service/service';
import { TOOL_NAMES } from '../src/tools';
import { FakeClock } from './support/fake-clock';
import { fakeFetch } from './support/fake-fetch';
import { ianaRoutes, loadFixture } from './support/fixtures';

let client: Client | null = null;
afterEach(async () => { await client?.close(); client = null; });

async function connect(): Promise<Client> {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    'https://rdap.apnic.net/ip/1.1.1.1': { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    'https://rdap.apnic.net/history/ip/1.1.1.1': { body: loadFixture('rdap/apnic/history-ip/1.1.1.1.json') },
  });
  const service = new RirService({ fetch, clock, userAgent: 'test', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(service).connect(serverT);
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

  it('returns isError with an example for bad input', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_asn_lookup', arguments: { asn: 'AS-FOO' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('AS4608');
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
});
