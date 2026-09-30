import type { Clock } from '../../src/ports';

export class FakeClock implements Clock {
  t = Date.UTC(2026, 8, 30);

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}
