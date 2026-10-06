import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
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

  it('keeps the scan-detector salt across eviction, so a repeated unit is not counted twice', async () => {
    await inDo('do-salt', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha)));
    await evictDurableObject(stub('do-salt'));
    const units = await inDo('do-salt', async (d) => {
      await text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.7' }), alpha)); // same /24
      return runInDurableObject(stub('do-salt'), (_i, state) =>
        (JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM gate WHERE key = 'alpha'").one().value) as { units: string[] }).units);
    });
    expect(units).toHaveLength(1);
  });

  it('schedules an alarm that purges scan digests of expired windows', async () => {
    const alarm = await inDo('do-alarm', async (d) => {
      await text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha));
      return runInDurableObject(stub('do-alarm'), (_i, state) => state.storage.getAlarm());
    });
    expect(alarm).toBeGreaterThan(Date.now());
    await runInDurableObject(stub('do-alarm'), (_i, state) => {
      // Age the window so the alarm finds it expired.
      state.storage.sql.exec("UPDATE gate SET value = json_set(value, '$.windowStart', 0) WHERE key = 'alpha'");
    });
    expect(await runDurableObjectAlarm(stub('do-alarm'))).toBe(true);
    const units = await runInDurableObject(stub('do-alarm'), (_i, state) =>
      (JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM gate WHERE key = 'alpha'").one().value) as { units: string[] }).units);
    expect(units).toEqual([]);
  });

  it('purges expired cache rows in its alarm: queried values do not stay in storage (audit 2026-10-07 L4)', async () => {
    await inDo('do-cache-purge', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha)));
    const keys = () => runInDurableObject(stub('do-cache-purge'), (_i, state) =>
      state.storage.sql.exec<{ key: string }>('SELECT key FROM cache').toArray().map((r) => r.key));
    expect(await keys()).toContain('ip:1.1.1.1');
    await runInDurableObject(stub('do-cache-purge'), (_i, state) => {
      state.storage.sql.exec('UPDATE cache SET stale_until = 1'); // long expired
    });
    expect(await runDurableObjectAlarm(stub('do-cache-purge'))).toBe(true);
    expect(await keys()).toEqual([]);
  });

  it('keeps its alarm within the hour, so digests and expired rows never wait for a far-off expiry (code review 2026-10-07 C1)', async () => {
    const HOUR = 3_600_000;
    const alarmAt = () => runInDurableObject(stub('do-alarm-hour'), (_i, state) => state.storage.getAlarm());
    await inDo('do-alarm-hour', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha)));
    // alpha's window ends; the alarm then finds only cache rows that expire in a day or more.
    await runInDurableObject(stub('do-alarm-hour'), (_i, state) => {
      state.storage.sql.exec("UPDATE gate SET value = json_set(value, '$.windowStart', 0)");
    });
    expect(await runDurableObjectAlarm(stub('do-alarm-hour'))).toBe(true);
    expect(await alarmAt()).toBeLessThanOrEqual(Date.now() + HOUR);
    // An alarm armed far ahead (by older code, or any other path) is brought forward by the next request.
    await runInDurableObject(stub('do-alarm-hour'), (_i, state) => state.storage.setAlarm(Date.now() + 7 * 24 * HOUR));
    await inDo('do-alarm-hour', async (d) => text(await d.serve(call('rdap_asn_lookup', { asn: 'AS4608' }), { clientId: 'beta', quotaPerHour: 60 })));
    expect(await alarmAt()).toBeLessThanOrEqual(Date.now() + HOUR);
  });

  it('waits at least 5 minutes between alarms, not one alarm per cache expiry (code review 2026-10-07 I1)', async () => {
    await inDo('do-alarm-gap', async (d) => text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha)));
    await runInDurableObject(stub('do-alarm-gap'), (_i, state) => {
      state.storage.sql.exec('UPDATE cache SET stale_until = ?', Date.now() + 1_000); // expires in a second
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub('do-alarm-gap'))).toBe(true);
    const at = await runInDurableObject(stub('do-alarm-gap'), (_i, state) => state.storage.getAlarm());
    expect(at).toBeGreaterThanOrEqual(before + 5 * 60_000);
  });

  it('still returns the answer when arming the purge alarm fails', async () => {
    const out = await inDo('do-alarm-fail', async (d) => {
      const storage = (d as unknown as { ctx: DurableObjectState }).ctx.storage;
      const spy = vi.spyOn(storage, 'getAlarm').mockRejectedValue(new Error('storage reset'));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const answer = await text(await d.serve(call('rdap_ip_lookup', { address: '1.1.1.1' }), alpha));
        return { answer, lines: logSpy.mock.calls.map((a) => a.map(String).join(' ')) };
      } finally {
        spy.mockRestore();
        logSpy.mockRestore();
      }
    });
    expect(out.answer).toContain('1.1.1.0/24');
    // Logged by type only: the message could carry anything.
    expect(out.lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ error: 'Error' }));
    expect(out.lines.join('\n')).not.toContain('storage reset');
  });
});
