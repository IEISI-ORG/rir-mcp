import { buildUserAgent } from '@ieisi/rir-mcp-core';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface NodeConfig {
  readonly operator: string;
  readonly userAgent: string;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): NodeConfig {
  const operator = env.RIR_MCP_OPERATOR?.trim() ?? '';
  if (operator === '') {
    throw new ConfigError(
      'RIR_MCP_OPERATOR is required: a contact email or URL for whoever runs this server. ' +
        'It is sent in the User-Agent so the RIRs can reach you.',
    );
  }
  try {
    return { operator, userAgent: buildUserAgent(operator) };
  } catch (err) {
    throw new ConfigError(`RIR_MCP_OPERATOR is invalid: ${(err as Error).message}`);
  }
}
