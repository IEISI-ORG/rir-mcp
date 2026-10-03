import { DurableObject } from 'cloudflare:workers';

/** The single stateful instance: runs the MCP handler over SQLite-backed state (Plan 3 Task 5). */
export class StateDO extends DurableObject<Env> {}
