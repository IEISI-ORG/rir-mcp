import { edgeGate } from '@ieisi/rir-mcp-core';
import { loadWorkerConfig, type WorkerEnv } from './config';

export { StateDO } from './state-do';

// One JSON line per event, read by Workers observability. Never pass header values, keys, query values or error messages.
const log = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));
const now = (): string => new Date().toISOString();

type Gate = ReturnType<typeof edgeGate>;
/** One gate per env object (stable per isolate), so the single key is hashed once, not per request. */
const gates = new WeakMap<object, Gate | { error: string }>();

function gateFor(env: WorkerEnv): Gate | { error: string } {
  let g = gates.get(env);
  if (!g) {
    const config = loadWorkerConfig(env);
    g = 'error' in config ? config : edgeGate({ ...config, log });
    gates.set(env, g);
  }
  return g;
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
      return await env.STATE.getByName('state').serve(request, admitted.client);
    } catch (err) {
      // DO errors (overload, reset, a constructor failure) end here. The message may hold query values: type only.
      log({ t: now(), status: 500, error: err instanceof Error ? err.name : typeof err });
      return Response.json({ error: 'internal' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
