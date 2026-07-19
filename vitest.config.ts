import { defineConfig } from 'vitest/config';

// Engine tests run in plain Node — no DOM, no browser globals.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
