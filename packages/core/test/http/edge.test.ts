import { describe, expect, it } from 'vitest';
import { SingleKeyStore } from '../../src/auth/keys';
import { edgeGate } from '../../src/http/edge';

const KEY = `rirmcp_${'A'.repeat(43)}`;
const WRONG = `rirmcp_${'B'.repeat(43)}`;

function setup() {
  const logs: Record<string, unknown>[] = [];
  const gate = edgeGate({
    keyStore: new SingleKeyStore(KEY),
    allowedHosts: ['mcp.example.net'],
    allowedOrigins: ['app.example.net'], // the SDK matches bare hostnames
    log: (l) => logs.push(l),
  });
  return { gate, logs };
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://mcp.example.net${path}`, {
    method: 'POST',
    headers: { host: 'mcp.example.net', 'content-type': 'application/json', ...headers },
    body: '{}',
  });
}

const auth = { authorization: `Bearer ${KEY}` };

describe('edgeGate', () => {
  it.each([
    ['wrong path', req('/other', auth), 404, 'not_found'],
    ['bad Host', req('/mcp', { ...auth, host: 'evil.example' }), 403, 'bad_host'],
    ['bad Origin', req('/mcp', { ...auth, origin: 'https://evil.example' }), 403, 'bad_origin'],
    ['no key', req('/mcp'), 401, 'unauthorized'],
    ['wrong key', req('/mcp', { authorization: `Bearer ${WRONG}` }), 401, 'unauthorized'],
  ])('rejects %s', async (_name, request, status, reason) => {
    const { gate, logs } = setup();
    const out = await gate(request);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(status);
    expect(logs).toEqual([{ t: expect.any(String), status, reason }]);
  });

  it('checks the path before Host, and Host before Origin and the key', async () => {
    const { gate } = setup();
    const out = await gate(req('/other', { host: 'evil.example', origin: 'https://evil.example' }));
    expect((out as Response).status).toBe(404);
    const out2 = await gate(req('/mcp', { host: 'evil.example', origin: 'https://evil.example' }));
    expect((out2 as Response).status).toBe(403);
  });

  it('passes an allowed request with the client and logs nothing', async () => {
    const { gate, logs } = setup();
    const out = await gate(req('/mcp', { ...auth, origin: 'https://app.example.net' }));
    expect(out).toEqual({ client: { clientId: 'default', quotaPerHour: 60 } });
    expect(logs).toEqual([]);
  });

  it('never logs header values', async () => {
    const { gate, logs } = setup();
    await gate(req('/mcp', { authorization: `Bearer ${WRONG}`, origin: 'https://evil.example' }));
    await gate(req('/mcp', { authorization: `Bearer ${WRONG}` }));
    const text = JSON.stringify(logs);
    for (const secret of [WRONG, 'evil.example', 'Bearer']) expect(text).not.toContain(secret);
  });

  it('logs a key-store failure as auth_error, not as a bad key', async () => {
    const logs: Record<string, unknown>[] = [];
    const gate = edgeGate({
      keyStore: { verify: () => Promise.reject(new Error('KV unavailable')) },
      allowedHosts: ['mcp.example.net'], allowedOrigins: [], log: (l) => logs.push(l),
    });
    const out = await gate(req('/mcp', auth));
    expect((out as Response).status).toBe(500);
    expect(logs).toEqual([{ t: expect.any(String), status: 500, reason: 'auth_error' }]);
  });
});
