import { parseKeyRecords, RecordKeyStore, type ClientInfo, type Clock, type KeyStore } from '@ieisi/rir-mcp-core';
import { ConfigError } from './errors';

export interface KeysFileIo {
  read(path: string): string;
}

export interface FileKeyStoreOptions {
  readonly checkEveryMs?: number;
  /** Called once per failed reload, and once when a failed file becomes valid again; the message names the file
   * and the problem, never its contents. */
  readonly onReloadError?: (message: string) => void;
}

/** Messages name the problem only: V8's JSON.parse errors can quote the input, and the input holds key hashes. */
function read(path: string, io: KeysFileIo): string {
  try {
    return io.read(path);
  } catch {
    throw new ConfigError(`keys file ${path} could not be read`);
  }
}

function parse(path: string, text: string): RecordKeyStore {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`keys file ${path} is not valid JSON`);
  }
  try {
    return new RecordKeyStore(parseKeyRecords(json));
  } catch (err) {
    throw new ConfigError(`keys file ${path}: ${(err as Error).message}`);
  }
}

/**
 * Per-user keys from a JSON file of key records, re-read at most every 30 s and reloaded when its contents
 * change, so adding or revoking a key needs no restart — the same model as Cloudflare KV (spec §7, Q4).
 * Fails closed throughout: a bad file stops startup, and a file that later becomes unreadable or invalid
 * rejects every key until it is fixed (an operator's half-finished revocation must not leave old keys live).
 * Contents, not mtime, decide "changed": copies that preserve mtime (cp -p, rsync -t) are still picked up.
 */
export class FileKeyStore implements KeyStore {
  private store: RecordKeyStore | null;
  private text: string | null;
  private lastCheck: number;
  private reported: string | null = null;
  private readonly checkEveryMs: number;

  constructor(
    private readonly path: string,
    private readonly io: KeysFileIo,
    private readonly clock: Clock,
    private readonly opts: FileKeyStoreOptions = {},
  ) {
    this.checkEveryMs = opts.checkEveryMs ?? 30_000;
    this.text = read(path, io);
    this.store = parse(path, this.text);
    this.lastCheck = clock.now();
  }

  async verify(presentedKey: string): Promise<ClientInfo | null> {
    this.maybeReload();
    return this.store ? this.store.verify(presentedKey) : null;
  }

  private maybeReload(): void {
    const now = this.clock.now();
    if (now - this.lastCheck < this.checkEveryMs) return;
    this.lastCheck = now;
    let text: string | null = null;
    try {
      text = read(this.path, this.io);
      if (text === this.text) return;
      this.store = parse(this.path, text);
      this.text = text;
      if (this.reported !== null) {
        this.reported = null;
        try { this.opts.onReloadError?.(`keys file ${this.path} is valid again; API keys accepted`); } catch { /* reporting must not break auth */ }
      }
    } catch (err) {
      this.store = null;
      this.text = text;
      const message = (err as Error).message;
      if (message === this.reported) return;
      this.reported = message;
      try { this.opts.onReloadError?.(`${message}; rejecting all API keys until it is fixed`); } catch { /* reporting must not break auth */ }
    }
  }
}
