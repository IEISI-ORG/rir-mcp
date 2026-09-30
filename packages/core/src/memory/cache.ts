import type { CacheEntry, CacheStore, Clock } from '../ports';

/** LRU cache in process memory. Map insertion order doubles as recency order. */
export class MemoryCache implements CacheStore {
  private readonly map = new Map<string, CacheEntry<unknown>>();
  private readonly clock: Clock;
  private readonly maxEntries: number;

  constructor(clock: Clock, maxEntries = 10_000) {
    this.clock = clock;
    this.maxEntries = maxEntries;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    if (this.clock.now() >= entry.staleUntil) return null;
    this.map.set(key, entry);
    return entry as CacheEntry<T>;
  }

  async put<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
