import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/contract/**'],
    globalSetup: ['test/setup/build-dist.ts'],
    setupFiles: ['test/setup/isolated-runtime.ts'],
  },
});
