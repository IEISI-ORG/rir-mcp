import { parseKeyRecords, RecordKeyStore, type ClientInfo, type Clock, type KeyStore } from '@ieisi/rir-mcp-core';
import { ConfigError } from './errors';

export interface KeysFileIo {
  read(path: string): string;
  mtimeMs(path: string): number;
}

export interface FileKeyStoreOptions {
  readonly checkEveryMs?: number;
  /** Called once per failed reload; the message names the file and the problem, never its contents. */
  readonly onReloadError?: (message: string) => void;
}

/** Messages name the problem only: V8's JSON.parse errors can quote the input, and the input holds key hashes. */
function load(path: string, io: KeysFileIo): RecordKeyStore {
  let json: unknown;
  try {
    json = JSON.parse(io.read(path));
  } catch (err) {
    const why = err instanceof SyntaxError ? 'is not valid JSON' : 'could not be read';
    throw new ConfigError(`keys file ${path} ${why}`);
  }
  try {
    return new RecordKeyStore(parseKeyRecords(json));
  } catch (err) {
    throw new ConfigError(`keys file ${path}: ${(err as Error).message}`);
  }
}

/**
 * Per-user keys from a JSON file of key records, reloaded when the file changes (checked at most every 30 s),
 * so adding or revoking a key needs no restart — the same model as Cloudflare KV (spec §7, QUESTIONS.md Q4).
 * Startup fails closed on a bad file; a bad file later keeps the last good key set.
 */
export class FileKeyStore implements KeyStore {
  private store: RecordKeyStore;
  private mtime: number;
  private lastCheck: number;
  private failedVersion: number | null = null;
  private readonly checkEveryMs: number;

  constructor(
    private readonly path: string,
    private readonly io: KeysFileIo,
    private readonly clock: Clock,
    private readonly opts: FileKeyStoreOptions = {},
  ) {
    this.checkEveryMs = opts.checkEveryMs ?? 30_000;
    this.mtime = this.stat();
    this.store = load(path, io);
    this.lastCheck = clock.now();
  }

  async verify(presentedKey: string): Promise<ClientInfo | null> {
    this.maybeReload();
    return this.store.verify(presentedKey);
  }

  private stat(): number {
    try {
      return this.io.mtimeMs(this.path);
    } catch {
      throw new ConfigError(`keys file ${this.path} could not be read`);
    }
  }

  private maybeReload(): void {
    const now = this.clock.now();
    if (now - this.lastCheck < this.checkEveryMs) return;
    this.lastCheck = now;
    // -1 stands for "file unreadable", so repeated stat failures are also reported once.
    let version = -1;
    try {
      version = this.stat();
      if (version === this.mtime || version === this.failedVersion) return;
      this.store = load(this.path, this.io);
      this.mtime = version;
      this.failedVersion = null;
    } catch (err) {
      if (version === this.failedVersion) return;
      this.failedVersion = version;
      try { this.opts.onReloadError?.(`${(err as Error).message}; keeping the previous keys`); } catch { /* reporting must not break auth */ }
    }
  }
}
