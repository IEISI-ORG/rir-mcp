import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Vitest 4: @cloudflare/vitest-plugin 1.3.6 does not support Vitest 5 yet (Q12). Core and node stay on Vitest 5.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { OPERATOR: 'https://github.com/IEISI-ORG/rir-mcp/issues', ALLOWED_HOSTS: 'x', ALLOWED_ORIGINS: '' },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
