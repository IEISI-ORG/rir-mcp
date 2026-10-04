export interface BodyLimits {
  readonly maxBytes: number;
  readonly deadlineMs: number;
}

/** Same bound as the MCP handler's maxRequestBodySize; checked here so an oversized body never reaches the DO. */
export const MAX_BODY_BYTES = 65_536;
/** A client that cannot send 64 KiB in this long is not an MCP client: don't let it hold a DO request open. */
export const BODY_DEADLINE_MS = 10_000;

const json = (status: number, error: string) => Response.json({ error }, { status });

/**
 * Reads the body at the edge, after authentication, within a deadline and a size limit, and returns a request
 * with the body buffered (or the 413/408 to send). The Durable Object then never waits on a slow client.
 */
export async function bufferBody(request: Request, limits: BodyLimits): Promise<Request | Response> {
  if (!request.body) return request;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limits.maxBytes) {
    await request.body.cancel().catch(() => undefined);
    return json(413, 'payload_too_large');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => undefined);
  }, limits.deadlineMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return json(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  } catch {
    return timedOut ? json(408, 'request_timeout') : json(400, 'bad_request');
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return json(408, 'request_timeout');
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}
