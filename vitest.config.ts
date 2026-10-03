import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The Worker package runs under Vitest 4 in workerd: corepack pnpm test:worker.
    exclude: ['packages/worker/**', '**/node_modules/**'],
  },
});
