import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import type { ClientGate, ClientInfo } from '../ports';
import { createServer } from '../server';
import type { RirService } from '../service/service';

export interface McpHandlerOptions {
  readonly service: RirService;
  readonly gate: ClientGate;
  /** One structured line per call. Never handed header values, keys or query values. */
  readonly log: (line: Record<string, unknown>) => void;
  readonly onError?: (err: unknown) => void;
}

export interface McpHandler {
  /** `client` must come from `edgeGate`: this handler does no authentication of its own. */
  fetch(req: Request, client: ClientInfo): Promise<Response>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 65_536;

/** The SDK's auth record for an admitted client. The token is blanked so nothing downstream can log it; the SDK
 * requires an expiry, so give one. */
export function authInfoFor(client: ClientInfo): AuthInfo {
  return {
    token: '', clientId: client.clientId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { quotaPerHour: client.quotaPerHour },
  };
}

/** The MCP endpoint for an already-authenticated client. Runtime-neutral: a web `fetch` handler. */
export function mcpHandler(o: McpHandlerOptions): McpHandler {
  const handler = createMcpHandler((ctx) => {
    const auth = ctx.authInfo;
    if (!auth) throw new Error('unauthenticated request reached the MCP handler');
    const client = { clientId: auth.clientId, quotaPerHour: Number(auth.extra?.quotaPerHour) };
    return createServer(o.service.forClient({ client, gate: o.gate }), {
      onError: o.onError,
      onCall: (l) => o.log({ t: new Date().toISOString(), ...l, client: client.clientId }),
    });
    // maxSubscriptions 0: refuse subscriptions/listen. This server never emits list-changed events, and an open
    // SSE stream would bypass the quota, scan detector and request timeouts (audit 2026-10-04).
  }, { maxRequestBodySize: MAX_BODY_BYTES, maxSubscriptions: 0, responseMode: 'json', onerror: (err) => o.onError?.(err) });

  return {
    fetch: (req, client) => handler.fetch(req, { authInfo: authInfoFor(client) }),
    close: () => handler.close(),
  };
}
