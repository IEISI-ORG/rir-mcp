import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { ClientInfo } from '@ieisi/rir-mcp-core';
import { describe, expect, it, vi } from 'vitest';
// workerd has no filesystem: fixtures are bundled as JSON imports instead of read with node:fs.
import ianaAsn from '../../../fixtures/iana/asn.json';
import ianaV4 from '../../../fixtures/iana/ipv4.json';
import ianaV6 from '../../../fixtures/iana/ipv6.json';
import apnicAs4608 from '../../../fixtures/rdap/apnic/autnum/4608.json';
import apnicIp1111 from '../../../fixtures/rdap/apnic/ip/1.1.1.1.json';
import { fakeFetch, type FakeFetch } from '../../core/test/support/fake-fetch';
import type { StateDO } from '../src/state-do';

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };

const rpc = (id: number, method: string, params: unknown): Request => new Request('https://do/mcp', {
  method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
});

const initialize = () => rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
const call = (name: string, args: Record<string, unknown>) => rpc(2, 'tools/call', { name, arguments: args });

function fixtureFetch(): FakeFetch {
  return fakeFetch({
    'https://data.iana.org/rdap/ipv4.json': { body: ianaV4 },
    'https://data.iana.org/rdap/ipv6.json': { body: ianaV6 },
    'https://data.iana.org/rdap/asn.json': { body: ianaAsn },
    'https://rdap.apnic.net/ip/1.1.1.1': { body: apnicIp1111 },
    'https://rdap.apnic.net/autnum/4608': { body: apnicAs4608 },
  });
}

/** 2025-era requests get a one-shot SSE response; responseMode 'json' applies to 2026-07-28 exchanges only. */
async function text(res: Response): Promise<string> {
  const raw = await res.text();
  const json = raw.startsWith('event:') ? raw.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '' : raw;
  const body = JSON.parse(json) as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  return body.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(body);
}

const stub = (name: string) => env.STATE.getByName(name);

function inDo<R>(name: string, fn: (instance: StateDO) => Promise<R>): Promise<R> {
  return runInDurableObject(stub(name), async (instance: StateDO) => {
    instance.upstream = fixtureFetch();
    return fn(instance);
  });
}

const alpha: ClientInfo = { clientId: 'alpha', quotaPerHour: 60 };

describe('StateDO.serve', () => {
  it('answers initialize', async () => {
    const res = await inDo('do-init', (d) => d.serve(initialize(), alpha));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('rir-mcp');
  });

  it('answers a tool call from upstream RDAP', async () => {
    const out = await inDo('do-ip', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha)));
    expect(out).toContain('APNIC');
    expect(out).toContain('1.1.1.0/24');
  });

  it('enforces the quota, still answers from cache, and keeps the quota across eviction', async () => {
    const one: ClientInfo = { clientId: 'one', quotaPerHour: 1 };
    const first = await inDo('do-quota', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), one)));
    expect(first).toContain('1.1.1.0/24');

    await evictDurableObject(stub('do-quota'));

    const [second, cached, upstreamCalls] = await inDo('do-quota', async (d) => {
      const s = await text(await d.serve(call('rdap_asn_lookup', { asn: 'AS4608' }), one));
      const c = await text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), one));
      return [s, c, (d.upstream as FakeFetch).calls.filter((u) => u.startsWith('https://rdap.')).length] as const;
    });
    expect(second).toMatch(/quota/i);
    expect(cached).toContain('1.1.1.0/24');
    expect(upstreamCalls).toBe(0); // refused before upstream; the repeat came from the persisted cache
  });

  it('logs calls as JSON lines with the client id and no query values', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    try {
      await inDo('do-log', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha)));
      lines = spy.mock.calls.map((a) => a.map(String).join(' ')); // read before mockRestore, which clears them
    } finally {
      spy.mockRestore();
    }
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toContainEqual(expect.objectContaining({ tool: 'rdap_ip_lookup', client: 'alpha' }));
    expect(lines.join('\n')).not.toContain('1.1.1.1');
  });
});
