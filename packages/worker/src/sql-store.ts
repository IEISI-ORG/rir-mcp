import type { CacheEntry, CacheStore, Clock, StateMap } from '@ieisi/rir-mcp-core';

/** Key/value tables for the limiter, the client gate and small metadata. Identifiers cannot be bound, so they are fixed. */
const STATE_TABLES = ['limiter', 'gate', 'meta'] as const;
type StateTable = (typeof STATE_TABLES)[number];

/** Idempotent: safe to run in every constructor. */
export function createTables(sql: SqlStorage): void {
  for (const t of STATE_TABLES) sql.exec(`CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL, fresh_until INTEGER NOT NULL, stale_until INTEGER NOT NULL, used_at INTEGER NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS cache_used_at ON cache (used_at)');
}

/** A `StateMap` over one SQLite table. Values go through JSON, so callers must `set` after every change. */
export class SqlStateMap<V> implements StateMap<V> {
  private readonly sql: SqlStorage;
  private readonly table: StateTable;

  constructor(sql: SqlStorage, table: string) {
    if (!(STATE_TABLES as readonly string[]).includes(table)) throw new Error(`unknown state table: ${table}`);
    this.sql = sql;
    this.table = table as StateTable;
  }

  get(key: string): V | undefined {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM ${this.table} WHERE key = ?`, key).toArray()[0];
    return row === undefined ? undefined : (JSON.parse(row.value) as V);
  }

  set(key: string, value: V): void {
    this.sql.exec(
      `INSERT INTO ${this.table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key, JSON.stringify(value),
    );
  }
}

export interface SqlCacheLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

interface CacheRow extends Record<string, SqlStorageValue> {
  value: string;
  fetched_at: number;
  fresh_until: number;
  stale_until: number;
}

const encoder = new TextEncoder();

/**
 * LRU cache in the Durable Object's SQLite, bounded by entry count and by total value bytes (audit 2026-10-03 #4).
 * Every method is synchronous inside: no await between a read and the write that depends on it.
 */
export class SqlCache implements CacheStore {
  private readonly sql: SqlStorage;
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  /** Recency counter, not the clock: two hits in the same millisecond must still be ordered. */
  private seq: number;

  constructor(sql: SqlStorage, clock: Clock, limits: SqlCacheLimits = {}) {
    this.sql = sql;
    this.clock = clock;
    this.maxEntries = limits.maxEntries ?? 10_000;
    this.maxBytes = limits.maxBytes ?? 50_000_000;
    this.seq = sql.exec<{ m: number }>('SELECT coalesce(max(used_at), 0) AS m FROM cache').one().m;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const row = this.sql.exec<CacheRow>(
      'SELECT value, fetched_at, fresh_until, stale_until FROM cache WHERE key = ?', key,
    ).toArray()[0];
    if (!row) return null;
    if (this.clock.now() >= row.stale_until) {
      this.sql.exec('DELETE FROM cache WHERE key = ?', key);
      return null;
    }
    this.sql.exec('UPDATE cache SET used_at = ? WHERE key = ?', ++this.seq, key);
    return { value: JSON.parse(row.value) as T, fetchedAt: row.fetched_at, freshUntil: row.fresh_until, staleUntil: row.stale_until };
  }

  async put<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const value = JSON.stringify(entry.value);
    const bytes = encoder.encode(value).length;
    if (bytes > this.maxBytes / 100) {
      // Not cached; and an older entry for this key must not be served as if it were still current.
      this.sql.exec('DELETE FROM cache WHERE key = ?', key);
      return;
    }
    this.sql.exec(
      `INSERT INTO cache (key, value, bytes, fetched_at, fresh_until, stale_until, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, fetched_at = excluded.fetched_at,
         fresh_until = excluded.fresh_until, stale_until = excluded.stale_until, used_at = excluded.used_at`,
      key, value, bytes, entry.fetchedAt, entry.freshUntil, entry.staleUntil, ++this.seq,
    );
    this.evict();
  }

  private evict(): void {
    let { n, b } = this.sql.exec<{ n: number; b: number }>('SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM cache').one();
    while (n > this.maxEntries || b > this.maxBytes) {
      const oldest = this.sql.exec<{ key: string; bytes: number }>('SELECT key, bytes FROM cache ORDER BY used_at LIMIT 1').toArray()[0];
      if (!oldest) break;
      this.sql.exec('DELETE FROM cache WHERE key = ?', oldest.key);
      n -= 1;
      b -= oldest.bytes;
    }
  }
}
