import { defineConfig } from 'vitest/config';

// Vitest runs the TypeScript tests under test/ in a plain Node environment.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
