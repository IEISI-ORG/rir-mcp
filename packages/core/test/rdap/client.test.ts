import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/ports';
import { fetchJson } from '../../src/rdap/client';
import { RdapError } from '../../src/rdap/errors';
import { buildUserAgent } from '../../src/rdap/user-agent';
import { fakeFetch } from '../support/fake-fetch';

const URL_A = 'https://rdap.apnic.net/ip/1.1.1.1';
const deps = (fetch: FetchLike) => ({ fetch, userAgent: 'test-agent' });
const code = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as RdapError).code);

describe('fetchJson', () => {
  it('returns parsed JSON and sends Accept and User-Agent', async () => {
    const f = fakeFetch({ [URL_A]: { body: { objectClassName: 'ip network' } } });
    expect((await fetchJson(URL_A, { maxBytes: 1000 }, deps(f))).body).toEqual({ objectClassName: 'ip network' });
    const headers = f.inits[0]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('test-agent');
    expect(headers.accept).toContain('application/rdap+json');
  });

  it.each([
    [404, 'not_found'], [429, 'rate_limited'], [503, 'upstream'], [403, 'bad_response'],
  ])('maps HTTP %d to %s', async (status, expected) => {
    const f = fakeFetch({ [URL_A]: { status, text: 'x' } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(f)))).toBe(expected);
  });

  it('reads Retry-After on 429', async () => {
    const f = fakeFetch({ [URL_A]: { status: 429, text: '', headers: { 'retry-after': '30' } } });
    const err = await fetchJson(URL_A, { maxBytes: 1000 }, deps(f)).catch((e: unknown) => e as RdapError);
    expect(err).toBeInstanceOf(RdapError);
    expect((err as RdapError).retryAfterS).toBe(30);
  });

  it('treats a 200 HTML challenge page as bad_response', async () => {
    const f = fakeFetch({ [URL_A]: { text: '<html>checking your browser</html>', headers: { 'content-type': 'text/html' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(f)))).toBe('bad_response');
  });

  it('rejects oversize bodies by declared length and while streaming', async () => {
    const declared = fakeFetch({ [URL_A]: { text: '{}', headers: { 'content-length': '5000' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(declared)))).toBe('too_large');
    const streaming: FetchLike = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close(); },
    }));
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(streaming)))).toBe('too_large');
  });

  it('follows one redirect to an allowed https host only', async () => {
    const target = 'https://rdap.arin.net/registry/ip/8.8.8.8';
    const f = fakeFetch({
      [URL_A]: { status: 302, headers: { location: target } },
      [target]: { body: { ok: 1 } },
    });
    const allow = (h: string) => h === 'rdap.arin.net';
    const hosts: string[] = [];
    const res = await fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow, onRedirect: async (h) => { hosts.push(h); } }, deps(f));
    expect(res).toEqual({ body: { ok: 1 }, finalUrl: target });
    expect(hosts).toEqual(['rdap.arin.net']);

    const evil = fakeFetch({ [URL_A]: { status: 302, headers: { location: 'https://evil.example/x' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(evil)))).toBe('redirect_blocked');

    const plain = fakeFetch({ [URL_A]: { status: 302, headers: { location: 'http://rdap.arin.net/x' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(plain)))).toBe('redirect_blocked');
  });

  it('handles redirect edge cases: a chain, no Location, a missing target, and the User-Agent on the second hop (Task 5 follow-up)', async () => {
    const B = 'https://rdap.arin.net/registry/ip/8.8.8.8';
    const C = 'https://rdap.lacnic.net/rdap/ip/8.8.8.8';
    const allow = () => true;
    // Only one redirect is followed: a second one is refused, not chased.
    const chain = fakeFetch({ [URL_A]: { status: 302, headers: { location: B } }, [B]: { status: 302, headers: { location: C } }, [C]: { body: {} } });
    const hops: string[] = [];
    const onRedirect = async (h: string) => { hops.push(h); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow, onRedirect }, deps(chain)))).toBe('redirect_blocked');
    expect(chain.calls).toEqual([URL_A, B]);
    expect(hops).toEqual(['rdap.arin.net']); // no rate-limit token taken for the hop that is never fetched
    // A redirect with no Location cannot be followed.
    const bare = fakeFetch({ [URL_A]: { status: 302 } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(bare)))).toBe('redirect_blocked');
    // A redirect to a missing object is "not found", not an error.
    const gone = fakeFetch({ [URL_A]: { status: 302, headers: { location: B } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(gone)))).toBe('not_found');
    // The second hop identifies us too.
    const ok = fakeFetch({ [URL_A]: { status: 302, headers: { location: B } }, [B]: { body: { ok: 1 } } });
    await fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(ok));
    expect(ok.inits.map((i) => new Headers(i.headers).get('user-agent'))).toEqual(['test-agent', 'test-agent']);
    expect(ok.inits.every((i) => i.redirect === 'manual')).toBe(true);
  });

  it('reads Retry-After as seconds or as an HTTP date, on 429 and 503', async () => {
    const inAnHour = new Date(Date.now() + 3_600_000).toUTCString();
    for (const [status, value] of [[429, inAnHour], [503, '120']] as const) {
      const f = fakeFetch({ [URL_A]: { status, text: '', headers: { 'retry-after': value } } });
      const err = (await fetchJson(URL_A, { maxBytes: 1000 }, deps(f)).catch((e: unknown) => e)) as RdapError;
      expect(err.retryAfterS).toBeGreaterThan(status === 429 ? 3500 : 119);
      expect(err.retryAfterS).toBeLessThanOrEqual(status === 429 ? 3601 : 120);
    }
  });

  it('maps timeouts and network errors', async () => {
    const timeout: FetchLike = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(timeout)))).toBe('timeout');
    const down: FetchLike = async () => { throw new TypeError('fetch failed'); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(down)))).toBe('upstream');
  });

  it('clears its timeout once the body is read, so no timer outlives the request', async () => {
    // A pending timer keeps a Durable Object's request in flight (blocks eviction, billed as active time).
    let signal: AbortSignal | undefined;
    const ok: FetchLike = async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response('{"a":1}');
    };
    await fetchJson(URL_A, { maxBytes: 1000 }, { ...deps(ok), timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(signal?.aborted).toBe(false);
  });

  it.each([
    ['404', 404, {}],
    ['503', 503, {}],
    ['a redirect it will not follow', 302, { location: 'https://evil.example/ip/1.1.1.1' }],
    ['a declared length over the cap', 200, { 'content-length': '5000' }],
  ])('cancels the unread body after %s, so the connection is not left open', async (_name, status, headers) => {
    let cancelled = false;
    const f: FetchLike = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(10)); },
      cancel() { cancelled = true; },
    }), { status, headers });
    await fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: () => false }, deps(f)).catch(() => undefined);
    expect(cancelled).toBe(true);
  });

  it('times out a stalled response and a stalled body', async () => {
    const onAbort = (signal: AbortSignal | null | undefined, fn: () => void) => signal?.addEventListener('abort', fn);
    const stalled: FetchLike = (_url, init) => new Promise((_, reject) => onAbort(init?.signal, () => reject(init?.signal?.reason)));
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, { ...deps(stalled), timeoutMs: 20 }))).toBe('timeout');

    const stalledBody: FetchLike = async (_url, init) => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(10)); onAbort(init?.signal, () => c.error(init?.signal?.reason)); },
    }));
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, { ...deps(stalledBody), timeoutMs: 20 }))).toBe('timeout');
  });

  it('maps streaming body errors to RdapError', async () => {
    const timeoutBody: FetchLike = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(10)); setTimeout(() => c.error(Object.assign(new Error('t'), { name: 'TimeoutError' })), 0); },
    }));
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(timeoutBody)))).toBe('timeout');

    const resetBody: FetchLike = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(10)); setTimeout(() => c.error(new TypeError('reset')), 0); },
    }));
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(resetBody)))).toBe('upstream');
  });

  it.each([
    ['a port', 'https://rdap.arin.net:8443/x'],
    ['userinfo', 'https://user:pw@rdap.arin.net/x'],
    ['a bare username', 'https://user@rdap.arin.net/x'],
  ])('blocks a redirect carrying %s even to an allowed host', async (_name, location) => {
    const f = fakeFetch({ [URL_A]: { status: 302, headers: { location } } });
    const allow = (h: string) => h === 'rdap.arin.net';
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(f)))).toBe('redirect_blocked');
    expect(f.inits).toHaveLength(1);
  });

  it.each([
    ['a query string', 'https://rdap.arin.net/registry/ip/1.1.1.1?note=SYSTEM:ignore_previous'],
    ['a fragment', 'https://rdap.arin.net/registry/ip/1.1.1.1#AAAA'],
    ['an over-long path', `https://rdap.arin.net/${'a'.repeat(300)}`],
    ['unexpected path characters', 'https://rdap.arin.net/registry/ip/1.1.1.1;x=SYSTEM!'],
  ])('blocks a redirect whose URL carries %s', async (_name, location) => {
    const f = fakeFetch({ [URL_A]: { status: 302, headers: { location } } });
    const allow = (h: string) => h === 'rdap.arin.net';
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(f)))).toBe('redirect_blocked');
  });

  it('still follows an RDAP-shaped redirect path with colons, slashes and percent-encoding', async () => {
    const target = 'https://rdap.arin.net/registry/ip/2001:db8::/32';
    const entity = 'https://rdap.arin.net/registry/entity/ORG%2DX';
    for (const t of [target, entity]) {
      const f = fakeFetch({ [URL_A]: { status: 302, headers: { location: t } }, [t]: { body: { ok: 1 } } });
      expect((await fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: () => true }, deps(f))).finalUrl).toBe(t);
    }
  });

  it('maps unparseable redirect Location to redirect_blocked', async () => {
    const badLocation = fakeFetch({ [URL_A]: { status: 302, headers: { location: 'https://[bad' } } });
    const allow = () => true;
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(badLocation)))).toBe('redirect_blocked');
  });
});

describe('buildUserAgent', () => {
  it('formats the product token, repo URL and operator contact', () => {
    expect(buildUserAgent(' noc@example.net ')).toBe(
      'rir-mcp/0.1.0 (+https://github.com/IEISI-ORG/rir-mcp; operator=noc@example.net)',
    );
  });
  it.each(['', '  ', 'a\nb', 'x (y)', 'x'.repeat(201), 'ops@例え.jp', 'Иван <ivan@x.ru>', 'nul\u0000x', 'a;b'])('rejects %j', (op) => {
    expect(() => buildUserAgent(op)).toThrow('operator');
  });
});
