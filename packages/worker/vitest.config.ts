import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Vitest 4: @cloudflare/vitest-plugin 1.3.6 does not support Vitest 5 yet (Q12). Core and node stay on Vitest 5.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-only values. API_KEY is a fixed, well-known test key: never a real secret.
        bindings: {
          OPERATOR: 'https://github.com/IEISI-ORG/rir-mcp/issues',
          ALLOWED_HOSTS: 'mcp.example.net',
          ALLOWED_ORIGINS: 'app.example.net',
          KEYS_MODE: '',
          API_KEY: `rirmcp_${'T'.repeat(43)}`,
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
