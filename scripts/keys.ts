/**
 * API key tool for self-hosted HTTP (spec §7). Keys are printed once and never stored; only hashes are.
 *   tsx scripts/keys.ts new <clientId> [quotaPerHour]  → line 1: the key (give it to the client)
 *                                                        line 2: the record to add to RIR_MCP_KEYS_FILE
 *   tsx scripts/keys.ts new --raw                      → a key for RIR_MCP_API_KEY (single-key mode)
 *   tsx scripts/keys.ts hash <key>                     → the key's SHA-256, to find or revoke its record
 * Plan 3 adds `--target kv` for Cloudflare.
 */
import { CLIENT_ID_RE, DEFAULT_QUOTA_PER_HOUR, generateKey, KEY_RE, sha256Hex } from '../packages/core/src/auth/keys';

const USAGE = 'usage: keys.ts new <clientId> [quotaPerHour] | new --raw | hash <key>';

function fail(why: string): never {
  console.error(`keys.ts: ${why}\n${USAGE}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'new' && rest.length === 1 && rest[0] === '--raw') {
  console.log(generateKey());
} else if (command === 'new' && (rest.length === 1 || rest.length === 2)) {
  const [clientId = '', quotaText] = rest;
  // clientId appears in logs: opaque IDs only, never a person's name or email (QUESTIONS.md Q3).
  if (!CLIENT_ID_RE.test(clientId)) fail('clientId must match ^[a-z0-9][a-z0-9-]{0,31}$ (an opaque id, not a name or email)');
  const quotaPerHour = quotaText === undefined ? DEFAULT_QUOTA_PER_HOUR : Number(quotaText);
  if (!/^\d+$/.test(quotaText ?? '1') || !Number.isInteger(quotaPerHour) || quotaPerHour < 1) fail('quotaPerHour must be a positive integer');
  const key = generateKey();
  console.log(key);
  console.log(JSON.stringify({ sha256: await sha256Hex(key), clientId, quotaPerHour }));
} else if (command === 'hash' && rest.length === 1) {
  const key = rest[0] ?? '';
  if (!KEY_RE.test(key)) fail('not an rir-mcp key (rirmcp_ followed by 43 base64url characters)');
  console.log(await sha256Hex(key));
} else {
  fail(command === undefined ? 'no command given' : `unknown arguments: ${[command, ...rest].join(' ')}`);
}
