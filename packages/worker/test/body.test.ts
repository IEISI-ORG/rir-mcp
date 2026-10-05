import { describe, expect, it } from 'vitest';
import { bufferBody } from '../src/body';

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('https://mcp.example.net/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('bufferBody', () => {
  it('passes a small body through intact, with method and headers', async () => {
    const out = await bufferBody(post('{"jsonrpc":"2.0"}', { authorization: 'Bearer x' }), { maxBytes: 1000, deadlineMs: 1000 });
    expect(out).toBeInstanceOf(Request);
    const r = out as Request;
    expect(r.method).toBe('POST');
    expect(r.headers.get('authorization')).toBe('Bearer x');
    expect(await r.text()).toBe('{"jsonrpc":"2.0"}');
  });

  it('answers 413 for a body over the limit, declared or streamed', async () => {
    const declared = await bufferBody(post('x'.repeat(10), { 'content-length': '5000' }), { maxBytes: 1000, deadlineMs: 1000 });
    expect((declared as Response).status).toBe(413);
    const streamed = await bufferBody(post(new ReadableStream({
      start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(100)); c.close(); },
    })), { maxBytes: 1000, deadlineMs: 1000 });
    expect((streamed as Response).status).toBe(413);
  });

  it('answers 408 when the body does not arrive within the deadline', async () => {
    const stalled = post(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }));
    const started = Date.now();
    const out = await bufferBody(stalled, { maxBytes: 1000, deadlineMs: 50 });
    expect((out as Response).status).toBe(408);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('drops a body sent with GET or HEAD instead of throwing', async () => {
    const withBody = { method: 'GET', headers: {}, url: 'https://mcp.example.net/mcp', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.close(); } }) } as unknown as Request;
    const out = await bufferBody(withBody, { maxBytes: 1000, deadlineMs: 1000 });
    expect(out).toBeInstanceOf(Request);
    expect((out as Request).method).toBe('GET');
    expect((out as Request).body).toBeNull();
  });

  it('leaves a request without a body as it is', async () => {
    const get = new Request('https://mcp.example.net/mcp', { method: 'GET' });
    expect(await bufferBody(get, { maxBytes: 1000, deadlineMs: 50 })).toBe(get);
  });
});
