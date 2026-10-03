/** Runtime-provided capabilities. Core code depends only on these interfaces. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface CacheEntry<T> {
  readonly value: T;
  readonly fetchedAt: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

export interface CacheStore {
  /** Returns null when absent or when now >= staleUntil. */
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  put<T>(key: string, entry: CacheEntry<T>): Promise<void>;
}

export type AcquireResult = { readonly ok: true } | { readonly ok: false; readonly retryAfterS: number };

export interface RateLimiter {
  acquire(bucket: string, weight: number): Promise<AcquireResult>;
  /** Called after upstream 429/5xx/timeout/bad response: back off this bucket. */
  penalise(bucket: string): Promise<void>;
}

export interface ClientInfo {
  readonly clientId: string;
  readonly quotaPerHour: number;
}

export interface KeyStore {
  /** The client a presented API key belongs to, or null when unknown or revoked. */
  verify(presentedKey: string): Promise<ClientInfo | null>;
}
