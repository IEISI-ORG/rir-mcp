import { sha256Hex } from '@ieisi/rir-mcp-core';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config';
import { FileKeyStore, type KeysFileIo } from '../src/keys-file';

const KEY_A = `rirmcp_${'A'.repeat(43)}`;
const KEY_B = `rirmcp_${'B'.repeat(43)}`;

class FakeIo implements KeysFileIo {
  text = '[]';
  reads = 0;
  read(): string { this.reads++; return this.text; }
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
    clock.t = 29_999;
    expect(await store.verify(KEY_A)).not.toBeNull();
    clock.t = 30_000;
    expect(await store.verify(KEY_A)).toBeNull();
    expect(await store.verify(KEY_B)).toEqual({ clientId: 'beta', quotaPerHour: 60 });
  });

  it('reads the file at most once per 30 s however many requests arrive', async () => {
    const io = new FakeIo();
    clock.t = 0;
    const store = new FileKeyStore('/keys.json', io, clock);
    for (let t = 0; t < 30_000; t += 1_000) {
      clock.t = t;
      await store.verify(KEY_A);
    }
    expect(io.reads).toBe(1);
    clock.t = 30_000;
    await store.verify(KEY_A);
    expect(io.reads).toBe(2);
  });

  it('picks up an edit that keeps the same mtime (cp -p, rsync -t)', async () => {
    const io = new FakeIo();
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    clock.t = 0;
    const store = new FileKeyStore('/keys.json', io, clock);
    io.text = JSON.stringify([await record(KEY_A, 'alpha', { revoked: true })]);
    clock.t = 30_000;
    expect(await store.verify(KEY_A)).toBeNull();
  });

  it('fails closed while the file is invalid, reports once, and recovers when fixed', async () => {
    const io = new FakeIo();
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    clock.t = 0;
    const errors: string[] = [];
    const store = new FileKeyStore('/keys.json', io, clock, { onReloadError: (m) => errors.push(m) });
    io.text = 'not json';
    clock.t = 30_000;
    expect(await store.verify(KEY_A)).toBeNull();
    clock.t = 60_000;
    expect(await store.verify(KEY_A)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('not json');
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    clock.t = 90_000;
    expect(await store.verify(KEY_A)).toEqual({ clientId: 'alpha', quotaPerHour: 60 });
    // Operators see the recovery as well as the failure, once.
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatch(/valid again/);
    io.text = JSON.stringify([await record(KEY_A, 'alpha'), await record(KEY_B, 'beta')]);
    clock.t = 120_000;
    await store.verify(KEY_A);
    expect(errors).toHaveLength(2); // an ordinary change after recovery is not reported
  });

  it('fails closed when the file disappears', async () => {
    const io = new FakeIo();
    io.text = JSON.stringify([await record(KEY_A, 'alpha')]);
    clock.t = 0;
    const store = new FileKeyStore('/keys.json', io, clock, { onReloadError: () => {} });
    io.read = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    clock.t = 30_000;
    expect(await store.verify(KEY_A)).toBeNull();
  });
});
