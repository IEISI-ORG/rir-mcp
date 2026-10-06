import { edgeGate } from '@ieisi/rir-mcp-core';
import { BODY_DEADLINE_MS, bufferBody, MAX_BODY_BYTES } from './body';
import { loadWorkerConfig, type WorkerEnv } from './config';

export { StateDO } from './state-do';

// One JSON line per event, read by Workers observability. Never pass header values, keys, query values or error messages.
const log = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));
const now = (): string => new Date().toISOString();

type Gate = ReturnType<typeof edgeGate>;

/**
 * Built from env on every request, never cached at module level: Cloudflare may keep running isolates when only
 * bindings change, so a cached gate would keep accepting a rotated or revoked API_KEY. The cost is one SHA-256.
 */
function gateFor(env: WorkerEnv): Gate | { error: string } {
  let config: ReturnType<typeof loadWorkerConfig>;
  try {
    config = loadWorkerConfig(env);
  } catch {
    // An unexpected setting shape must still give the documented 503, not an opaque exception for every request.
    return { error: 'config' };
  }
  return 'error' in config ? config : edgeGate({ ...config, log });
}

/** Edge Worker (spec §6, Q9): path → Host → Origin → key here, then one RPC to the single StateDO. */
export default {
  async fetch(request, env): Promise<Response> {
    const gate = gateFor(env);
    if ('error' in gate) {
      log({ t: now(), status: 503, reason: 'not_configured', setting: gate.error });
      return Response.json({ error: 'not_configured' }, { status: 503 });
    }
    const admitted = await gate(request);
    if (admitted instanceof Response) return admitted;
    try {
      // Buffer the body here, within a deadline and the size limit, so a slow client never holds the DO open.
      const buffered = await bufferBody(request, { maxBytes: MAX_BODY_BYTES, deadlineMs: BODY_DEADLINE_MS });
      if (buffered instanceof Response) {
        const reason = buffered.status === 413 ? 'too_large' : buffered.status === 408 ? 'slow_body' : 'bad_body';
        log({ t: now(), status: buffered.status, reason });
        return buffered;
      }
      return await env.STATE.getByName('state').serve(buffered, admitted.client);
    } catch (err) {
      // DO errors (overload, reset, a constructor failure) end here. The message may hold query values: type only.
      log({ t: now(), status: 500, error: err instanceof Error ? err.name : typeof err });
      return Response.json({ error: 'internal' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
