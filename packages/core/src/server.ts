import { McpServer } from '@modelcontextprotocol/server';
import { INSTRUCTIONS, USAGE_GUIDE } from './guide/text';
import type { RirService } from './service/service';
import { registerTools } from './tools';
import { VERSION } from './version';

export const SERVER_INFO = { name: 'rir-mcp', version: VERSION } as const;

export function createServer(service: RirService): McpServer {
  const server = new McpServer({ ...SERVER_INFO }, { instructions: INSTRUCTIONS });
  registerTools(server, service);
  server.registerResource(
    'usage-guide',
    'guide://usage',
    { title: 'rir-mcp usage guide', description: 'Which question maps to which tool, with examples.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: USAGE_GUIDE }] }),
  );
  return server;
}
