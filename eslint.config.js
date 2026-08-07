// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'fixtures/**', 'node_modules/**', 'artifacts/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // stdout belongs to the MCP JSON-RPC transport. A stray console.log
      // corrupts the protocol stream. All logging goes to stderr via pino.
      'no-console': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    // The single-chokepoint rule (plan Phase 1): only src/http/** may speak HTTP.
    // Everything else must go through src/http/request.ts, which is the only
    // place the mandatory DCSC header/query preamble is applied. Omitting any
    // part of that preamble produces an HTTP 500 from DCSC, so this is enforced
    // structurally rather than by convention.
    files: ['src/**/*.ts'],
    ignores: ['src/http/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'undici',
              message:
                'Only src/http/** may import undici. Use send() from src/http/request.ts so the mandatory DCSC preamble is applied.',
            },
            {
              name: 'node:http',
              message: 'Use send() from src/http/request.ts instead.',
            },
            {
              name: 'node:https',
              message: 'Use send() from src/http/request.ts instead.',
            },
          ],
        },
      ],
    },
  },

  {
    // Scripts are developer tooling, not part of the served surface.
    files: ['scripts/**/*.ts', 'test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
