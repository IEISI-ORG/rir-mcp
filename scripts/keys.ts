/**
 * API key tool (spec §7). Keys are printed once and never stored; only hashes are. No network calls: for Cloudflare
 * it prints the wrangler command for the operator to run (from packages/worker).
 *   tsx scripts/keys.ts new <clientId> [quotaPerHour]  → line 1: the key (give it to the client)
 *                                                        line 2: the record to add to RIR_MCP_KEYS_FILE
 *   tsx scripts/keys.ts new <clientId> [quota] --target kv
 *                                                      → line 1: the key; line 2: the `wrangler kv key put` command
 *   tsx scripts/keys.ts new --raw                      → a key for RIR_MCP_API_KEY or the Worker's API_KEY secret
 *   tsx scripts/keys.ts hash <key>                     → the key's SHA-256, to find or revoke its record
 *   tsx scripts/keys.ts revoke <key|sha256> --target kv → the `wrangler kv key delete` command
 */
import { CLIENT_ID_RE, DEFAULT_QUOTA_PER_HOUR, generateKey, KEY_RE, sha256Hex } from '../packages/core/src/auth/keys';

const USAGE = 'usage: keys.ts new <clientId> [quotaPerHour] [--target kv] | new --raw | hash <key> | revoke <key|sha256> --target kv';
const HASH_RE = /^[0-9a-f]{64}$/;
const KV = 'npx wrangler kv key';

function fail(why: string): never {
  console.error(`keys.ts: ${why}\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let target: 'file' | 'kv' = 'file';
const at = args.indexOf('--target');
if (at !== -1) {
  if (args[at + 1] !== 'kv') fail('--target must be kv');
  target = 'kv';
  args.splice(at, 2);
}
const [command, ...rest] = args;

if (command === 'new' && rest.length === 1 && rest[0] === '--raw') {
  // A single Worker key is a secret (wrangler secret put API_KEY), not a KV record.
  if (target === 'kv') fail('new --raw has no KV form; pipe the key into `npx wrangler secret put API_KEY` instead');
  console.log(generateKey());
} else if (command === 'new' && (rest.length === 1 || rest.length === 2)) {
  const [clientId = '', quotaText] = rest;
  // clientId appears in logs: opaque IDs only, never a person's name or email (QUESTIONS.md Q3).
  if (!CLIENT_ID_RE.test(clientId)) fail('clientId must match ^[a-z0-9][a-z0-9-]{0,31}$ (an opaque id, not a name or email)');
  const quotaPerHour = quotaText === undefined ? DEFAULT_QUOTA_PER_HOUR : Number(quotaText);
  if (!/^\d+$/.test(quotaText ?? '1') || !Number.isInteger(quotaPerHour) || quotaPerHour < 1) fail('quotaPerHour must be a positive integer');
  const key = generateKey();
  const sha256 = await sha256Hex(key);
  console.log(key);
  if (target === 'kv') {
    // The record holds only shell-safe characters (clientId is [a-z0-9-], quota is digits), so single quotes suffice.
    console.log(`${KV} put ${sha256} '${JSON.stringify({ clientId, quotaPerHour })}' --binding API_KEYS --remote`);
  } else {
    console.log(JSON.stringify({ sha256, clientId, quotaPerHour }));
  }
} else if (command === 'hash' && rest.length === 1) {
  const key = rest[0] ?? '';
  if (!KEY_RE.test(key)) fail('not an rir-mcp key (rirmcp_ followed by 43 base64url characters)');
  console.log(await sha256Hex(key));
} else if (command === 'revoke' && rest.length === 1) {
  if (target !== 'kv') fail('revoke prints a KV command: add --target kv (for a keys file, set "revoked": true on the record)');
  const arg = rest[0] ?? '';
  // Operators rarely still have the key (it is shown once), so its hash works too.
  const hash = HASH_RE.test(arg) ? arg : KEY_RE.test(arg) ? await sha256Hex(arg) : fail('revoke needs a key or its 64-hex SHA-256');
  console.log(`${KV} delete ${hash} --binding API_KEYS --remote`);
} else {
  fail(command === undefined ? 'no command given' : `unknown arguments: ${[command, ...rest].join(' ')}`);
}
