import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadHttpConfig } from '../src/config';

describe('loadConfig', () => {
  it('requires an operator contact', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ RIR_MCP_OPERATOR: '  ' })).toThrow('RIR_MCP_OPERATOR');
  });

  it('rejects contacts that could break the User-Agent', () => {
    expect(() => loadConfig({ RIR_MCP_OPERATOR: 'a\r\nX-Evil: 1' })).toThrow(ConfigError);
  });

  it('builds the User-Agent', () => {
    expect(loadConfig({ RIR_MCP_OPERATOR: 'noc@example.net' })).toEqual({
      operator: 'noc@example.net',
      userAgent: 'rir-mcp/0.1.0 (+https://github.com/IEISI-ORG/rir-mcp; operator=noc@example.net)',
    });
  });
});

describe('loadHttpConfig', () => {
  const OP = { RIR_MCP_OPERATOR: 'noc@example.net' };
  const KEY = `rirmcp_${'A'.repeat(43)}`;
  const io = (text = '[]') => ({ read: () => text, mtimeMs: () => 1 });

  it('defaults to loopback, port 8787, localhost hosts/origins, single-key mode', () => {
    const c = loadHttpConfig({ ...OP, RIR_MCP_API_KEY: KEY }, io());
    expect(c).toMatchObject({ host: '127.0.0.1', port: 8787, authMode: 'single', userAgent: expect.stringContaining('noc@example.net') });
    expect(c.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(c.allowedOrigins).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('prefers the keys file over a single key', () => {
    expect(loadHttpConfig({ ...OP, RIR_MCP_API_KEY: KEY, RIR_MCP_KEYS_FILE: '/k.json' }, io()).authMode).toBe('per-user');
  });

  it.each([
    ['no key source', {}, /refusing to start without authentication/],
    ['malformed single key', { RIR_MCP_API_KEY: 'hunter2' }, /RIR_MCP_API_KEY/],
    ['public bind without allowed hosts', { RIR_MCP_API_KEY: KEY, RIR_MCP_HTTP_HOST: '0.0.0.0' }, /RIR_MCP_ALLOWED_HOSTS/],
    ['non-numeric port', { RIR_MCP_API_KEY: KEY, RIR_MCP_HTTP_PORT: '80a' }, /RIR_MCP_HTTP_PORT/],
    ['port out of range', { RIR_MCP_API_KEY: KEY, RIR_MCP_HTTP_PORT: '70000' }, /RIR_MCP_HTTP_PORT/],
    ['zero quota', { RIR_MCP_API_KEY: KEY, RIR_MCP_QUOTA_PER_HOUR: '0' }, /RIR_MCP_QUOTA_PER_HOUR/],
  ])('rejects %s', (_name, env, message) => {
    expect(() => loadHttpConfig({ ...OP, ...env }, io())).toThrow(message);
    expect(() => loadHttpConfig({ ...OP, ...env }, io())).toThrow(ConfigError);
  });

  it('still requires the operator contact', () => {
    expect(() => loadHttpConfig({ RIR_MCP_API_KEY: KEY }, io())).toThrow(/RIR_MCP_OPERATOR/);
  });

  it('accepts a public bind with explicit allowed hosts and origins', () => {
    const c = loadHttpConfig({ ...OP, RIR_MCP_API_KEY: KEY, RIR_MCP_HTTP_HOST: '0.0.0.0', RIR_MCP_ALLOWED_HOSTS: 'rdap.example.net, ', RIR_MCP_ALLOWED_ORIGINS: 'app.example.net' }, io());
    expect(c.allowedHosts).toEqual(['rdap.example.net']);
    expect(c.allowedOrigins).toEqual(['app.example.net']);
  });

  it('applies RIR_MCP_QUOTA_PER_HOUR to the single key', async () => {
    const c = loadHttpConfig({ ...OP, RIR_MCP_API_KEY: KEY, RIR_MCP_QUOTA_PER_HOUR: '120' }, io());
    expect(await c.keyStore.verify(KEY)).toEqual({ clientId: 'default', quotaPerHour: 120 });
  });

  it('allows port 0 for tests', () => {
    expect(loadHttpConfig({ ...OP, RIR_MCP_API_KEY: KEY, RIR_MCP_HTTP_PORT: '0' }, io()).port).toBe(0);
  });
});
