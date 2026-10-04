import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ClientInfo } from '../ports';

/**
 * The SDK's auth record for an admitted client. The token is blanked so nothing downstream can log it; the SDK
 * requires an expiry, so give one. Its own module so the edge gate does not import the MCP server graph.
 */
export function authInfoFor(client: ClientInfo): AuthInfo {
  return {
    token: '', clientId: client.clientId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { quotaPerHour: client.quotaPerHour },
  };
}
