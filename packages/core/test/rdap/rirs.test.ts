import { describe, expect, it } from 'vitest';
import { rirForHost } from '../../src/rdap/rirs';

describe('rirForHost', () => {
  it('maps the five RIR RDAP hosts', () => {
    expect(rirForHost('rdap.apnic.net')).toBe('apnic');
    expect(rirForHost('rdap.afrinic.net')).toBe('afrinic');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'evil.example'])(
    'does not treat %j as an RIR host (audit 2026-10-04 #3)', (host) => {
      expect(rirForHost(host)).toBeUndefined();
    },
  );
});
