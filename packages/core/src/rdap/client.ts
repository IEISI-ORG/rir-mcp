import type { FetchLike } from '../ports';
import { RdapError } from './errors';

export interface HttpDeps {
  readonly fetch: FetchLike;
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

const RDAP_PATH = /^\/[A-Za-z0-9._:\/%-]{1,200}$/;

export const MAX_BYTES = { current: 2_000_000, history: 5_000_000 } as const;

export interface FetchJsonOptions {
  readonly maxBytes: number;
  /** Redirects are followed once, only over https on the default port, without userinfo, only to hosts this returns true for. */
  readonly allowRedirectTo?: (host: string) => boolean;
  /** Called after the allow-list check passes and before the second hop; errors it throws propagate unchanged. */
  readonly onRedirect?: (host: string) => Promise<void>;
}

export interface FetchJsonResult {
  readonly body: unknown;
  /** The URL that produced the body, after any redirect. */
  readonly finalUrl: string;
}

export async function fetchJson(url: string, opts: FetchJsonOptions, deps: HttpDeps): Promise<FetchJsonResult> {
  let target = url;
  for (let hop = 0; hop < 2; hop++) {
    const timer = deadline(deps.timeoutMs ?? 10_000);
    try {
      const res = await send(target, deps, timer.signal);
      if (res.status >= 300 && res.status < 400) {
        target = redirectTarget(res, target, hop, opts);
        await opts.onRedirect?.(new URL(target).hostname);
        continue;
      }
      if (res.status === 404) throw new RdapError('not_found', `Not found: ${target}`, { status: 404 });
      if (res.status === 429) {
        throw new RdapError('rate_limited', 'Upstream rate limit (HTTP 429)', {
          status: 429,
          retryAfterS: parseRetryAfter(res.headers.get('retry-after')),
        });
      }
      if (res.status >= 500) throw new RdapError('upstream', `Upstream error (HTTP ${res.status})`, { status: res.status });
      if (res.status !== 200) throw new RdapError('bad_response', `Unexpected HTTP ${res.status}`, { status: res.status });
      const text = await readCapped(res, opts.maxBytes);
      try {
        return { body: JSON.parse(text) as unknown, finalUrl: target };
      } catch {
        throw new RdapError('bad_response', `Non-JSON response from ${new URL(target).hostname}`, { status: 200 });
      }
    } finally {
      // Cleared once the body is read: a pending timer would keep a Durable Object's request in flight.
      timer.clear();
    }
  }
  throw new RdapError('redirect_blocked', 'Too many redirects');
}

/** Like AbortSignal.timeout, but clearable. Covers the response headers and the body read. */
function deadline(ms: number): { readonly signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}

async function send(target: string, deps: HttpDeps, signal: AbortSignal): Promise<Response> {
  try {
    return await deps.fetch(target, {
      redirect: 'manual',
      headers: { accept: 'application/rdap+json, application/json', 'user-agent': deps.userAgent },
      signal,
    });
  } catch (err) {
    throw mapNetworkError(err, `Fetching ${target}`);
  }
}

function mapNetworkError(err: unknown, context: string): RdapError {
  if (err instanceof RdapError) return err;
  const name = (err as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return new RdapError('timeout', `Timed out ${context}`);
  return new RdapError('upstream', `Network error ${context}`);
}

function redirectTarget(res: Response, from: string, hop: number, opts: FetchJsonOptions): string {
  const location = res.headers.get('location');
  if (!location || hop > 0) throw new RdapError('redirect_blocked', `Unfollowable redirect from ${from}`, { status: res.status });
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new RdapError('redirect_blocked', `Invalid redirect Location from ${from}`, { status: res.status });
  }
  // The final URL is shown to the model (meta.url), so only the host may come from the bootstrap and the rest
  // must look like an RDAP path: no query, no fragment, a short path of RDAP characters.
  const plain = next.port === '' && next.username === '' && next.password === ''
    && next.search === '' && next.hash === '' && RDAP_PATH.test(next.pathname);
  if (next.protocol !== 'https:' || !plain || !opts.allowRedirectTo?.(next.hostname)) {
    throw new RdapError('redirect_blocked', `Redirect to ${next.hostname} is not an RDAP bootstrap host`, { status: res.status });
  }
  return next.toString();
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new RdapError('too_large', `Response too large (${declared} bytes)`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RdapError('too_large', `Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    throw mapNetworkError(err, 'reading response body');
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}
