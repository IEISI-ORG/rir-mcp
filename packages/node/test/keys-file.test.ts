import { sha256Hex } from '@ieisi/rir-mcp-core';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config';
import { FileKeyStore, type KeysFileIo } from '../src/keys-file';

const KEY_A = `rirmcp_${'A'.repeat(43)}`;
const KEY_B = `rirmcp_${'B'.repeat(43)}`;

class FakeIo implements KeysFileIo {
  text = '[]';
  mtime = 1;
  reads = 0;
  read(): string { this.reads++; return this.text; }
  mtimeMs(): number { return this.mtime; }
}

const clock = { t: 0, now() { return this.t; } };
const record = async (key: string, clientId: string, extra: object = {}) =>
  ({ sha256: await sha256Hex(key), clientId, quotaPerHour: 60, ...extra });

describe('FileKeyStore', () => {
  it('loads at construction and verifies keys', async () => {
    const io = new FakeIo();
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    const store = new FileKeyStore('/keys.json', io, clock);
    expect(await store.verify(KEY_A)).toEqual({ clientId: 'alpha', quotaPerHour: 60 });
    expect(await store.verify(KEY_B)).toBeNull();
  });

  it('fails closed at startup on an invalid file, without echoing its contents', () => {
    const io = new FakeIo();
    io.text = '[{"sha256": "secret-looking-value" x]';
    expect(() => new FileKeyStore('/keys.json', io, clock)).toThrow(ConfigError);
    try { new FileKeyStore('/keys.json', io, clock); } catch (e) {
      expect((e as Error).message).toContain('/keys.json');
      expect((e as Error).message).not.toContain('secret-looking-value');
    }
  });

  it('picks up added and revoked keys after the file changes, at most every 30 s', async () => {
    const io = new FakeIo();
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    clock.t = 0;
    const store = new FileKeyStore('/keys.json', io, clock);
    io.text = JSON.stringify([await record(KEY_A, 'alpha', { revoked: true }), await record(KEY_B, 'beta')]);
    io.mtime = 2;
    clock.t = 29_999;
    expect(await store.verify(KEY_A)).not.toBeNull();
    clock.t = 30_000;
    expect(await store.verify(KEY_A)).toBeNull();
    expect(await store.verify(KEY_B)).toEqual({ clientId: 'beta', quotaPerHour: 60 });
  });

  it('does not re-read an unchanged file', async () => {
    const io = new FakeIo();
    clock.t = 0;
    const store = new FileKeyStore('/keys.json', io, clock);
    clock.t = 60_000;
    await store.verify(KEY_A);
    expect(io.reads).toBe(1);
  });

  it('keeps the last good key set when a reload fails, and reports it once per change', async () => {
    const io = new FakeIo();
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    clock.t = 0;
    const errors: string[] = [];
    const store = new FileKeyStore('/keys.json', io, clock, { onReloadError: (m) => errors.push(m) });
    io.text = 'not json';
    io.mtime = 2;
    clock.t = 30_000;
    expect(await store.verify(KEY_A)).toEqual({ clientId: 'alpha', quotaPerHour: 60 });
    clock.t = 60_000;
    await store.verify(KEY_A);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('not json');
  });
});
