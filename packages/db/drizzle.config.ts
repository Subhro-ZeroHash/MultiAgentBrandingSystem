import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs with cwd = packages/db, but the single source of truth for
// env is the repo root .env — resolve it explicitly rather than relying on cwd.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env'), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  // Both workstreams generate migrations against the same database; namespacing
  // by Postgres schema keeps `content` and `geo` changes from colliding.
  schemaFilter: ['core', 'content', 'geo'],
  verbose: true,
  strict: true,
});
