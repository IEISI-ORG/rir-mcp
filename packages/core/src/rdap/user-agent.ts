import { VERSION } from '../version';

// Printable ASCII only, no parentheses or semicolons (they delimit the User-Agent comment).
const CONTACT = /^[\x21-\x27\x2a-\x3a\x3c-\x7e](?:[\x20-\x27\x2a-\x3a\x3c-\x7e]*[\x21-\x27\x2a-\x3a\x3c-\x7e])?$/;

export const REPO_URL = 'https://github.com/IEISI-ORG/rir-mcp';

/** Every deployment identifies itself and its operator to the RIRs (spec §5). */
export function buildUserAgent(operator: string): string {
  const op = operator.trim();
  if (op.length > 200 || !CONTACT.test(op)) {
    throw new Error('operator must be a printable-ASCII contact (email or URL) without parentheses or semicolons, at most 200 characters');
  }
  return `rir-mcp/${VERSION} (+${REPO_URL}; operator=${op})`;
}
