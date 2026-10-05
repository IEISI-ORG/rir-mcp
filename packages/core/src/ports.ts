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
  /** Read-only: would acquire refuse now? Lets a caller skip charging a client for a lookup that cannot run. */
  check?(bucket: string, weight: number): Promise<AcquireResult>;
  /** Called after upstream 429/5xx/timeout/bad response: back off this bucket. */
  /** retryAfterS: the upstream's Retry-After, if any; the bucket is then refused until it has passed (capped). */
  penalise(bucket: string, retryAfterS?: number): Promise<void>;
}

export interface ClientInfo {
  readonly clientId: string;
  readonly quotaPerHour: number;
}

export interface KeyStore {
  /** The client a presented API key belongs to, or null when unknown or revoked. */
  verify(presentedKey: string): Promise<ClientInfo | null>;
}

export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'quota' | 'suspended' | 'rate'; readonly retryAfterS: number };

/** Per-client anti-harvesting controls (spec §7): hourly upstream quota and scan detection. */
export interface ClientGate {
  /** Charge `weight` upstream calls to the client's hourly quota. Denied charges are not counted. */
  /** retryWeight: what the whole request will need next time, if more than `weight`; a denial's retry time uses it. */
  charge(client: ClientInfo, weight: number, retryWeight?: number): Promise<GateResult>;
  /** Record one distinct /24, /48, ASN or handle queried this hour; suspends the client above the threshold. */
  observe(client: ClientInfo, unit: string): Promise<GateResult>;
  /** Return a charge that reached no upstream (e.g. the shared RIR limiter refused). Never goes below zero. */
  refund(client: ClientInfo, weight: number): Promise<void>;
}
