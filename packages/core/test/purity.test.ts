import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

describe('core stays runtime-agnostic (runs on Node and Workers)', () => {
  it.each(files(SRC))('%s', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/from ['"]node:/);
    expect(text).not.toMatch(/\bBuffer\b|\bprocess\./);
    expect(text.split('\n').length).toBeLessThan(400);
  });
});
