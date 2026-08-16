import { defineConfig } from 'vitest/config';

// The pure layer imports nothing from the DOM, so `node` is the honest
// environment: if a test needs jsdom, that module is not pure any more.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
