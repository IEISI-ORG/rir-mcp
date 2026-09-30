import type { FetchLike } from '../ports';
import { RdapError } from './errors';

export interface HttpDeps {
  readonly fetch: FetchLike;
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

export const MAX_BYTES = { current: 2_000_000, history: 5_000_000 } as const;

export interface FetchJsonOptions {
  readonly maxBytes: number;
  /** Redirects are followed once, only over https, only to hosts this returns true for. */
  readonly allowRedirectTo?: (host: string) => boolean;
}

export async function fetchJson(url: string, opts: FetchJsonOptions, deps: HttpDeps): Promise<unknown> {
  let target = url;
  for (let hop = 0; hop < 2; hop++) {
    const res = await send(target, deps);
    if (res.status >= 300 && res.status < 400) {
      target = redirectTarget(res, target, hop, opts);
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
      return JSON.parse(text) as unknown;
    } catch {
      throw new RdapError('bad_response', `Non-JSON response from ${new URL(target).hostname}`, { status: 200 });
    }
  }
  throw new RdapError('redirect_blocked', 'Too many redirects');
}

async function send(target: string, deps: HttpDeps): Promise<Response> {
  try {
    return await deps.fetch(target, {
      redirect: 'manual',
      headers: { accept: 'application/rdap+json, application/json', 'user-agent': deps.userAgent },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
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
  if (next.protocol !== 'https:' || !opts.allowRedirectTo?.(next.hostname)) {
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
