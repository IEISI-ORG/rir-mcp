import type { CacheEntry, CacheStore, Clock, StateMap } from '@ieisi/rir-mcp-core';

/** Key/value tables for the limiter, the client gate and small metadata. Identifiers cannot be bound, so they are fixed. */
const STATE_TABLES = ['limiter', 'gate', 'meta'] as const;
type StateTable = (typeof STATE_TABLES)[number];

/** Bump with a migration in createTables: CREATE TABLE IF NOT EXISTS never changes an existing table. */
const SCHEMA_VERSION = '1';

/** Idempotent: safe to run in every constructor. */
export function createTables(sql: SqlStorage): void {
  for (const t of STATE_TABLES) sql.exec(`CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const stored = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
  if (stored && JSON.parse(stored.value) !== SCHEMA_VERSION) throw new Error(`unsupported state schema version ${stored.value}`);
  // No version recorded: a cache table here predates versioning and may have any shape. Its contents are disposable.
  if (!stored) sql.exec('DROP TABLE IF EXISTS cache');
  // bytes before the large value column, so reading it never walks the value's overflow pages.
  sql.exec(`CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, used_at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL, fresh_until INTEGER NOT NULL, stale_until INTEGER NOT NULL, value TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS cache_used_at ON cache (used_at)');
  if (!stored) sql.exec("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", JSON.stringify(SCHEMA_VERSION));
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
  /** Running totals: this object is the table's only writer, so it scans once at start instead of on every put. */
  private entries: number;
  private bytes: number;

  constructor(sql: SqlStorage, clock: Clock, limits: SqlCacheLimits = {}) {
    this.sql = sql;
    this.clock = clock;
    this.maxEntries = limits.maxEntries ?? 10_000;
    this.maxBytes = limits.maxBytes ?? 50_000_000;
    const start = sql.exec<{ m: number; n: number; b: number }>(
      'SELECT coalesce(max(used_at), 0) AS m, count(*) AS n, coalesce(sum(bytes), 0) AS b FROM cache',
    ).one();
    this.seq = start.m;
    this.entries = start.n;
    this.bytes = start.b;
  }

  totals(): { entries: number; bytes: number } {
    return { entries: this.entries, bytes: this.bytes };
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const row = this.sql.exec<CacheRow>(
      'SELECT value, fetched_at, fresh_until, stale_until FROM cache WHERE key = ?', key,
    ).toArray()[0];
    if (!row) return null;
    if (this.clock.now() >= row.stale_until) {
      this.remove(key);
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
      this.remove(key);
      return;
    }
    this.remove(key);
    this.sql.exec(
      `INSERT INTO cache (key, bytes, used_at, fetched_at, fresh_until, stale_until, value) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      key, bytes, ++this.seq, entry.fetchedAt, entry.freshUntil, entry.staleUntil, value,
    );
    this.entries += 1;
    this.bytes += bytes;
    while (this.entries > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.sql.exec<{ key: string }>('SELECT key FROM cache ORDER BY used_at LIMIT 1').toArray()[0];
      if (!oldest) break;
      this.remove(oldest.key);
    }
  }

  /** The only way rows leave the table, so the running totals stay exact. */
  private remove(key: string): void {
    const gone = this.sql.exec<{ bytes: number }>('DELETE FROM cache WHERE key = ? RETURNING bytes', key).toArray()[0];
    if (!gone) return;
    this.entries -= 1;
    this.bytes -= gone.bytes;
  }
}

const HOUR_MS = 3_600_000;

/**
 * Clears the scan-detector digests of every client whose hourly window has ended, keeping counts and suspensions.
 * Spec §7 keeps counts, not values; the digests are salted but brute-forceable, so they must not outlive their hour
 * for a client that stops querying. Returns when the next window with digests ends, or null if none remain.
 * Reads the `ClientState` fields `windowStart` and `units` as JSON.
 */
export function purgeExpiredScanUnits(sql: SqlStorage, now: number): number | null {
  sql.exec(
    `UPDATE gate SET value = json_set(value, '$.units', json('[]'))
     WHERE json_array_length(value, '$.units') > 0 AND json_extract(value, '$.windowStart') <= ?`,
    now - HOUR_MS,
  );
  const next = sql.exec<{ w: number | null }>(
    `SELECT min(json_extract(value, '$.windowStart')) AS w FROM gate WHERE json_array_length(value, '$.units') > 0`,
  ).one().w;
  return next === null ? null : next + HOUR_MS;
}
