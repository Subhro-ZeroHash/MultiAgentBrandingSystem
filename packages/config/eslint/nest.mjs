import base, { providerSdkBoundary } from './base.mjs';

/**
 * NestJS apps.
 *
 * `consistent-type-imports` is OFF here, and must stay off. NestJS resolves
 * constructor dependencies from the metadata TypeScript emits under
 * `emitDecoratorMetadata`, which only exists for *value* imports. Rewriting
 * `import { FooService }` to `import { type FooService }` erases the runtime
 * import, the emitted metadata becomes `Object`, and the app dies at startup
 * with "Nest can't resolve dependencies of the FooController". The rule's
 * autofix does exactly that rewrite, so leaving it enabled here is a loaded gun.
 */
export default [
  ...base,
  providerSdkBoundary,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
