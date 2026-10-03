import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface FetchApp {
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Placeholder origin: routing uses the path only; Host is checked from the header by the app. */
const INTERNAL_ORIGIN = 'http://rir-mcp.invalid';

/**
 * Only origin-form targets ("/path?query") are honoured. Absolute-form ("http://other/x") and "//other/x"
 * map to "/" (and so to 404), so a request target can never steer the URL's host.
 */
export function toWebRequest(req: IncomingMessage, origin = INTERNAL_ORIGIN): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const target = req.url ?? '/';
  const path = target.startsWith('/') && !target.startsWith('//') ? target : '/';
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(new URL(path, origin), init);
}

export async function sendWebResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(r.status, headers);
  if (!r.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

export interface Listening {
  readonly port: number;
  close(): Promise<void>;
}

export async function startHttp(opts: { readonly host: string; readonly port: number }, app: FetchApp, onError?: (err: unknown) => void): Promise<Listening> {
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, (req, res) => {
    void (async () => {
      try {
        await sendWebResponse(res, await app.fetch(toWebRequest(req)));
      } catch (err) {
        // A client hanging up mid-response also lands here; never leak details either way.
        onError?.(err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal"}');
        else res.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => { server.off('error', reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
