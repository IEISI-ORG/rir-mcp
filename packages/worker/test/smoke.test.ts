import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('worker scaffold', () => {
  it('answers 404 for everything', async () => {
    const res = await exports.default.fetch(new Request('https://x/'));
    expect(res.status).toBe(404);
  });

  it('binds the StateDO namespace', () => {
    expect(typeof env.STATE.getByName).toBe('function');
  });
});
