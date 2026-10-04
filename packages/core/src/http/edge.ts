import {
  hostHeaderValidationResponse, OAuthError, OAuthErrorCode, originValidationResponse, requireBearerAuth,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { ClientInfo, KeyStore } from '../ports';

export interface EdgeGateOptions {
  readonly keyStore: KeyStore;
  readonly allowedHosts: string[];
  readonly allowedOrigins: string[];
  /** One structured line per rejection. Never handed header values, keys or query values. */
  readonly log: (line: Record<string, unknown>) => void;
}

type Reason = 'not_found' | 'bad_host' | 'bad_origin' | 'unauthorized' | 'auth_error';

/** Allow-list entries: the SDK matches Host/Origin by bare hostname (no scheme, no port; IPv6 in brackets). */
export const BARE_HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/** Path → Host → Origin → Bearer (spec §7). Returns the client, or the rejection to send. Runtime-neutral. */
export function edgeGate(o: EdgeGateOptions): (req: Request) => Promise<{ client: ClientInfo } | Response> {
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

  const reject = (status: number, reason: Reason, res: Response): Response => {
    o.log({ t: new Date().toISOString(), status, reason });
    return res;
  };

  return async (req) => {
    if (new URL(req.url).pathname !== '/mcp') {
      return reject(404, 'not_found', Response.json({ error: 'not_found' }, { status: 404 }));
    }
    const badHost = hostHeaderValidationResponse(req, o.allowedHosts);
    if (badHost) return reject(badHost.status, 'bad_host', badHost);
    const badOrigin = originValidationResponse(req, o.allowedOrigins);
    if (badOrigin) return reject(badOrigin.status, 'bad_origin', badOrigin);
    const auth = await authenticate(req);
    // A key store that throws (e.g. KV unavailable) surfaces as the SDK's 500: still a rejection, but not a bad key.
    if (auth instanceof Response) return reject(auth.status, auth.status >= 500 ? 'auth_error' : 'unauthorized', auth);
    return { client: { clientId: auth.clientId, quotaPerHour: Number(auth.extra?.quotaPerHour) } };
  };
}
