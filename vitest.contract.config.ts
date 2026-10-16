import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Offline request/response and serialization contracts. Live DCSC checks
    // remain opt-in through `npm run contract:live`.
    include: [
      'test/dcsc-wire.test.ts',
      'test/import.test.ts',
      'test/export-rack-shape.test.ts',
    ],
    setupFiles: ['test/setup/isolated-runtime.ts'],
  },
});
