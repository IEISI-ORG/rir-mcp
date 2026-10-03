import { createServer, type ClientGate, type KeyStore, type RirService } from '@ieisi/rir-mcp-core';
import {
  createMcpHandler, hostHeaderValidationResponse, OAuthError, OAuthErrorCode, originValidationResponse, requireBearerAuth,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { FetchApp } from './http-bridge';

export interface HttpAppOptions {
  readonly service: RirService;
  readonly gate: ClientGate;
  readonly keyStore: KeyStore;
  readonly allowedHosts: string[];
  readonly allowedOrigins: string[];
  /** One structured line per event. Callers must never be handed header values, keys or query values. */
  readonly log: (line: Record<string, unknown>) => void;
  readonly onError?: (err: unknown) => void;
}

type Reason = 'not_found' | 'bad_host' | 'bad_origin' | 'unauthorized';

const MAX_BODY_BYTES = 65_536;

/** Path → Host → Origin → Bearer → MCP (spec §7). Runtime-neutral: a web `fetch` handler. */
export function createHttpApp(o: HttpAppOptions): FetchApp {
  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      const client = await o.keyStore.verify(token);
      if (!client) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid API key');
      // The token is blanked so nothing downstream can log it; the SDK requires an expiry, so give one.
      return {
        token: '', clientId: client.clientId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { quotaPerHour: client.quotaPerHour },
      };
    },
  };
  const authenticate = requireBearerAuth({ verifier });

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

  const reject = (status: number, reason: Reason, res: Response): Response => {
    o.log({ t: new Date().toISOString(), status, reason });
    return res;
  };

  return {
    async fetch(req) {
      if (new URL(req.url).pathname !== '/mcp') {
        return reject(404, 'not_found', Response.json({ error: 'not_found' }, { status: 404 }));
      }
      const badHost = hostHeaderValidationResponse(req, o.allowedHosts);
      if (badHost) return reject(badHost.status, 'bad_host', badHost);
      const badOrigin = originValidationResponse(req, o.allowedOrigins);
      if (badOrigin) return reject(badOrigin.status, 'bad_origin', badOrigin);
      const auth = await authenticate(req);
      if (auth instanceof Response) return reject(auth.status, 'unauthorized', auth);
      return handler.fetch(req, { authInfo: auth });
    },
    close: () => handler.close(),
  };
}
