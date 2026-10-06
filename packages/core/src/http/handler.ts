import { createMcpHandler } from '@modelcontextprotocol/server';
import { authInfoFor } from './auth-info';
import type { ClientGate, ClientInfo, RequestGate } from '../ports';
import { createServer } from '../server';
import type { RirService } from '../service/service';

export interface McpHandlerOptions {
  readonly service: RirService;
  /** Limits lookups (ClientGate) and admits each HTTP request (RequestGate). */
  readonly gate: ClientGate & RequestGate;
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
    fetch: async (req, client) => {
      // Every request, whatever its method, before an MCP server is built for it: tools/list, ping and resources
      // floods are bounded per key too, not only lookups (audit 2026-10-07 L3). In memory, so no storage write.
      const admitted = await o.gate.admit(client);
      if (!admitted.ok) {
        o.log({ t: new Date().toISOString(), status: 429, reason: admitted.reason, client: client.clientId });
        return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(admitted.retryAfterS) } });
      }
      return handler.fetch(req, { authInfo: authInfoFor(client) });
    },
    close: () => handler.close(),
  };
}
