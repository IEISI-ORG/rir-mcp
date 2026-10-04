import type { CacheEntry, CacheStore, Clock } from '../ports';

export interface CacheLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

interface Slot {
  readonly entry: CacheEntry<unknown>;
  readonly bytes: number;
}

const encoder = new TextEncoder();

/**
 * LRU cache in process memory, bounded by entry count and by total value bytes (as JSON, like the Worker's SqlCache;
 * audit 2026-10-03 #4). Map insertion order doubles as recency order.
 */
export class MemoryCache implements CacheStore {
  private readonly map = new Map<string, Slot>();
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(clock: Clock, limits: CacheLimits = {}) {
    this.clock = clock;
    this.maxEntries = limits.maxEntries ?? 10_000;
    this.maxBytes = limits.maxBytes ?? 50_000_000;
  }

  totals(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.bytes };
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const slot = this.map.get(key);
    if (!slot) return null;
    this.map.delete(key);
    if (this.clock.now() >= slot.entry.staleUntil) {
      this.bytes -= slot.bytes;
      return null;
    }
    this.map.set(key, slot);
    return slot.entry as CacheEntry<T>;
  }

  async put<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.remove(key);
    const bytes = encoder.encode(JSON.stringify(entry.value)).length;
    // Not cached; the older entry for this key is already gone, so it cannot be served as if still current.
    if (bytes > this.maxBytes / 100) return;
    this.map.set(key, { entry, bytes });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(key: string): void {
    const slot = this.map.get(key);
    if (!slot) return;
    this.map.delete(key);
    this.bytes -= slot.bytes;
  }
}
