import { VERSION } from '../version';

export const REPO_URL = 'https://github.com/IEISI-ORG/rir-mcp';

/** Every deployment identifies itself and its operator to the RIRs (spec §5). */
export function buildUserAgent(operator: string): string {
  const op = operator.trim();
  if (op === '' || op.length > 200 || /[\r\n()]/.test(op)) {
    throw new Error('operator must be a single-line contact (email or URL) without parentheses, at most 200 characters');
  }
  return `rir-mcp/${VERSION} (+${REPO_URL}; operator=${op})`;
}
