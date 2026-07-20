import base, { providerSdkBoundary } from './base.mjs';

export default [
  ...base,
  providerSdkBoundary,
  {
    files: ['**/*.tsx'],
    rules: {
      // Server Components are the default; explicit `any` in props is still a smell.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
