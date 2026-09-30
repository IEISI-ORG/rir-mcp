export type RdapErrorCode =
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'timeout'
  | 'too_large'
  | 'bad_response'
  | 'redirect_blocked';

export class RdapError extends Error {
  readonly code: RdapErrorCode;
  readonly status: number | undefined;
  readonly retryAfterS: number | undefined;

  constructor(code: RdapErrorCode, message: string, opts: { status?: number; retryAfterS?: number } = {}) {
    super(message);
    this.name = 'RdapError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterS = opts.retryAfterS;
  }
}
