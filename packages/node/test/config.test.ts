import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

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
