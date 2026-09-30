import type { Rir } from '../rdap/rirs';
import type { SpecialUse } from '../special-use';

export interface Meta {
  readonly rir: Rir;
  readonly cache: 'miss' | 'hit' | 'stale';
  readonly ageS: number;
  /** The RDAP URL this answer came from; used as the "see" pointer for undisclosed contacts. */
  readonly url: string;
}

export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_delegated'
  | 'rate_limited'
  | 'upstream'
  | 'history_unavailable'
  | 'personal_record'
  | 'too_large';

export type Answer<T> =
  | { readonly kind: 'record'; readonly record: T; readonly meta: Meta }
  | { readonly kind: 'special'; readonly query: string; readonly special: SpecialUse }
  | { readonly kind: 'error'; readonly code: ErrorCode; readonly message: string; readonly retryAfterS?: number };
