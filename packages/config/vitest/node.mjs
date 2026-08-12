import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest base for the Node packages, alongside the eslint and tsconfig
 * bases in this package.
 *
 * `tsconfigRaw` is supplied inline rather than letting the transform read
 * tsconfig.json from disk. Every package's tsconfig reaches its settings through
 * `extends: "@bmas/config/tsconfig/node.json"`, and Vite's oxc transform does
 * not resolve a bare package specifier there the way tsc does — it reports
 * "Tsconfig not found" and no tests run at all. Only the transform is affected;
 * type checking still comes from the real tsconfig via `pnpm typecheck`.
 */
export default defineConfig({
  oxc: {
    tsconfigRaw: {
      compilerOptions: {
        target: 'es2022',
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    // These suites cover pure functions and stages driven by fakes; anything
    // reaching a real database or provider belongs in a separate integration
    // run, not here.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
