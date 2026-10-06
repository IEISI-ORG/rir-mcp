import { edgeGate, mcpHandler, type ClientGate, type KeyStore, type RequestGate, type RirService } from '@ieisi/rir-mcp-core';
import type { FetchApp } from './http-bridge';

export interface HttpAppOptions {
  readonly service: RirService;
  readonly gate: ClientGate & RequestGate;
  readonly keyStore: KeyStore;
  readonly allowedHosts: string[];
  readonly allowedOrigins: string[];
  /** One structured line per event. Callers must never be handed header values, keys or query values. */
  readonly log: (line: Record<string, unknown>) => void;
  readonly onError?: (err: unknown) => void;
}

/** Path → Host → Origin → Bearer → MCP (spec §7): the core edge gate, then the core MCP handler. */
export function createHttpApp(o: HttpAppOptions): FetchApp {
  const admit = edgeGate(o);
  const handler = mcpHandler(o);
  return {
    async fetch(req) {
      const admitted = await admit(req);
      return admitted instanceof Response ? admitted : handler.fetch(req, admitted.client);
    },
    close: () => handler.close(),
  };
}
