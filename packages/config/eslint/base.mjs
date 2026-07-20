import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Shared ESLint base. The `no-restricted-imports` block is the enforcement
 * mechanism for the model-abstraction boundary described in
 * docs/architecture.md: product code must not import a provider SDK directly.
 * Adapters under `packages/ai/src/adapters` re-enable them (see node.mjs usage).
 */
export const providerSdkBoundary = {
  files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
  ignores: ['packages/ai/src/adapters/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@anthropic-ai/sdk',
            message: 'Import provider SDKs only inside packages/ai/src/adapters. Use @bmas/ai.',
          },
          {
            name: '@google/genai',
            message: 'Import provider SDKs only inside packages/ai/src/adapters. Use @bmas/ai.',
          },
          {
            name: '@fal-ai/client',
            message: 'Import provider SDKs only inside packages/ai/src/adapters. Use @bmas/ai.',
          },
          {
            name: 'openai',
            message: 'Import provider SDKs only inside packages/ai/src/adapters. Use @bmas/ai.',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  { ignores: ['dist/**', '.next/**', 'node_modules/**', 'coverage/**', '*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
);
