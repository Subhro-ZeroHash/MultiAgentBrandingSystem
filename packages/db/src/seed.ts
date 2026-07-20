import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Local development seed. Idempotent — safe to re-run.
 *
 * Exists because the APIs have no auth yet: without a `core.users` row the
 * first `POST /api/brands` fails on the owner foreign key. Seeding a known
 * dev user (id `dev-user`, matched by `DEV_OWNER_ID`) makes the write paths
 * exercisable before auth lands.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env'), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
  process.exit(1);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });

const DEV_USER_ID = 'dev-user';
const DEV_BRAND_ID = 'dev-brand';

try {
  await db
    .insert(schema.users)
    .values({ id: DEV_USER_ID, email: 'dev@example.com', name: 'Dev User', emailVerified: true })
    .onConflictDoNothing();

  await db
    .insert(schema.brands)
    .values({
      id: DEV_BRAND_ID,
      ownerId: DEV_USER_ID,
      name: 'Priya Sarees',
      colors: ['#7C2D12', '#F59E0B'],
      toneOfVoice: 'traditional',
      category: 'Apparel / Saree boutique',
      audience: 'Women 25-45 in Jaipur shopping for festival and wedding wear',
      websiteUrl: 'https://example.com',
      socialHandles: { instagram: '@priyasarees' },
    })
    .onConflictDoNothing();

  await db
    .insert(schema.products)
    .values({
      brandId: DEV_BRAND_ID,
      name: 'Banarasi Silk Saree',
      description: 'Handwoven Banarasi silk saree with gold zari border.',
      priceMinor: 649_00,
      currency: 'INR',
    })
    .onConflictDoNothing();

  await db
    .insert(schema.competitors)
    .values([
      { brandId: DEV_BRAND_ID, name: 'Nalli Silks', domain: 'nalli.com', aliases: ['Nalli'] },
      { brandId: DEV_BRAND_ID, name: 'Kalaniketan', domain: null, aliases: [] },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.trackedPrompts)
    .values([
      {
        brandId: DEV_BRAND_ID,
        text: 'Where can I buy a good Banarasi silk saree in Jaipur?',
        intent: 'discovery',
        locale: 'IN',
        engines: ['claude', 'perplexity'],
      },
      {
        brandId: DEV_BRAND_ID,
        text: 'Best saree boutiques for wedding shopping in Rajasthan',
        intent: 'discovery',
        locale: 'IN',
        engines: ['claude', 'perplexity'],
      },
    ])
    .onConflictDoNothing();

  console.warn(`Seeded dev user (${DEV_USER_ID}) and brand (${DEV_BRAND_ID}).`);
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
