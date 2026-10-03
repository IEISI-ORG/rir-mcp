/**
 * Synchronous per-key state store for the limiter and client gate. A `Map` in Node; a SQLite table in the
 * Cloudflare Durable Object. Values are plain JSON, and callers `set` after every change, because the persisted
 * implementation returns copies: an in-place edit that is never `set` is lost.
 */
export interface StateMap<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
}
