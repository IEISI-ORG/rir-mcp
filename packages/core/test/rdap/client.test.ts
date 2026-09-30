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

  it('maps timeouts and network errors', async () => {
    const timeout: FetchLike = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(timeout)))).toBe('timeout');
    const down: FetchLike = async () => { throw new TypeError('fetch failed'); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(down)))).toBe('upstream');
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
