import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { TokenEncryption } from '@bmas/shared';
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

const client = postgres(url, {
  max: 1,
  onnotice: () => {},
  ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
});
const db = drizzle(client, { schema });

const DEV_USER_ID = 'dev-user';
const DEV_BRAND_ID = 'dev-brand';
// Explicit ids for every row below, not just user/brand: `onConflictDoNothing`
// only catches a conflict on the primary key, and these tables have no other
// unique constraint. Without a fixed id each re-run generated a fresh random
// UUID, so nothing ever conflicted and every `pnpm db:seed` duplicated them.
const DEV_PRODUCT_ID = 'dev-product-saree';
const DEV_COMPETITOR_NALLI_ID = 'dev-competitor-nalli';
const DEV_COMPETITOR_KALANIKETAN_ID = 'dev-competitor-kalaniketan';
const DEV_PROMPT_DISCOVERY_ID = 'dev-prompt-discovery';
const DEV_PROMPT_WEDDING_ID = 'dev-prompt-wedding';
const DEV_GOOGLE_ACCOUNT_ID = 'dev-google-account';
const DEV_REVIEW_IDS = [
  'dev-review-1',
  'dev-review-2',
  'dev-review-3',
  'dev-review-4',
  'dev-review-5',
] as const;

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
      name: 'My Brand',
      colors: ['#7C2D12', '#F59E0B'],
      tone: ['elegant', 'traditional', 'premium'],
      category: 'General Retail',
      audience: 'Quality conscious customers',
      location: 'Jaipur',
      languages: ['Hindi', 'English'],
      platforms: ['Instagram', 'Facebook'],
      bannedTopics: [],
      websiteUrl: 'https://example.com',
      socialHandles: { instagram: '@mybrand' },
    })
    .onConflictDoNothing();

  await db
    .insert(schema.products)
    .values({
      id: DEV_PRODUCT_ID,
      brandId: DEV_BRAND_ID,
      name: 'Banarasi Silk Saree',
      description: 'Handwoven Banarasi silk saree with gold zari border.',
      priceMinor: 649_00,
      currency: 'INR',
      sellingPoints: ['Pure silk', 'Handwoven', 'Traditional Banarasi design'],
    })
    .onConflictDoNothing();

  await db
    .insert(schema.competitors)
    .values([
      {
        id: DEV_COMPETITOR_NALLI_ID,
        brandId: DEV_BRAND_ID,
        name: 'Nalli Silks',
        domain: 'nalli.com',
        aliases: ['Nalli'],
      },
      {
        id: DEV_COMPETITOR_KALANIKETAN_ID,
        brandId: DEV_BRAND_ID,
        name: 'Kalaniketan',
        domain: null,
        aliases: [],
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.trackedPrompts)
    .values([
      {
        id: DEV_PROMPT_DISCOVERY_ID,
        brandId: DEV_BRAND_ID,
        text: 'Where can I buy a good Banarasi silk saree in Jaipur?',
        intent: 'discovery',
        locale: 'IN',
        engines: ['claude', 'perplexity'],
      },
      {
        id: DEV_PROMPT_WEDDING_ID,
        brandId: DEV_BRAND_ID,
        text: 'Best saree boutiques for wedding shopping in Rajasthan',
        intent: 'discovery',
        locale: 'IN',
        engines: ['claude', 'perplexity'],
      },
    ])
    .onConflictDoNothing();

  // Fixture Google connection + reviews: there is no live Business Profile
  // API access yet (see GoogleAuthService), so this stands in for what a real
  // OAuth connect + review sync would produce, and is the only way to
  // exercise the (fully automatic — see GoogleReviewsService) reply flow
  // locally. The two left as `needs_reply` demo that automation running live
  // the first time the reviews screen loads after a fresh seed.
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('ENCRYPTION_KEY is not set — cannot seed the fixture Google connection.');
    process.exit(1);
  }
  const encryption = new TokenEncryption(encryptionKey);

  await db
    .insert(schema.socialAccounts)
    .values({
      id: DEV_GOOGLE_ACCOUNT_ID,
      ownerId: DEV_USER_ID,
      platform: 'google',
      pageId: null,
      igBusinessId: 'dev-google-user-id',
      pageAccessToken: encryption.encrypt('fixture-google-access-token'),
      refreshToken: encryption.encrypt('fixture-google-refresh-token'),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      displayName: 'dev.brand@gmail.com',
      status: 'active',
    })
    .onConflictDoNothing();

  const DAY_MS = 24 * 60 * 60 * 1000;
  await db
    .insert(schema.googleReviews)
    .values([
      {
        id: DEV_REVIEW_IDS[0],
        brandId: DEV_BRAND_ID,
        socialAccountId: DEV_GOOGLE_ACCOUNT_ID,
        externalReviewId: 'fixture-review-1',
        reviewerName: 'Priya Sharma',
        rating: 5,
        reviewText:
          'Absolutely stunning saree! The zari work is even more beautiful in person. Delivery was quick too.',
        reviewedAt: new Date(Date.now() - 2 * DAY_MS),
        status: 'needs_reply',
      },
      {
        id: DEV_REVIEW_IDS[1],
        brandId: DEV_BRAND_ID,
        socialAccountId: DEV_GOOGLE_ACCOUNT_ID,
        externalReviewId: 'fixture-review-2',
        reviewerName: 'Anjali Mehta',
        rating: 2,
        reviewText:
          "Saree was nice but arrived a week later than promised, with no update on the delay. Customer service didn't respond to my calls.",
        reviewedAt: new Date(Date.now() - 4 * DAY_MS),
        status: 'needs_reply',
      },
      {
        id: DEV_REVIEW_IDS[2],
        brandId: DEV_BRAND_ID,
        socialAccountId: DEV_GOOGLE_ACCOUNT_ID,
        externalReviewId: 'fixture-review-3',
        reviewerName: 'Ritu Agarwal',
        rating: 5,
        reviewText:
          "Bought this for my daughter's wedding — the silk quality is premium and the color was exactly as shown online.",
        reviewedAt: new Date(Date.now() - 6 * DAY_MS),
        draftReply:
          "Thank you so much, Ritu! We're thrilled the saree was perfect for such a special occasion — congratulations to your daughter!",
        status: 'approved',
      },
      {
        id: DEV_REVIEW_IDS[3],
        brandId: DEV_BRAND_ID,
        socialAccountId: DEV_GOOGLE_ACCOUNT_ID,
        externalReviewId: 'fixture-review-4',
        reviewerName: 'Vikram Singh',
        rating: 3,
        reviewText:
          'Good product but a bit overpriced compared to similar sarees I found elsewhere in Jaipur.',
        reviewedAt: new Date(Date.now() - 9 * DAY_MS),
        draftReply:
          'Thank you for the honest feedback, Vikram — we price for handwoven quality and craftsmanship, but we appreciate you taking the time to compare and share your thoughts.',
        status: 'approved',
      },
      {
        id: DEV_REVIEW_IDS[4],
        brandId: DEV_BRAND_ID,
        socialAccountId: DEV_GOOGLE_ACCOUNT_ID,
        externalReviewId: 'fixture-review-5',
        reviewerName: 'Neha Kapoor',
        rating: 4,
        reviewText:
          'Lovely saree, exactly as pictured. Would have given 5 stars but the packaging could be better.',
        reviewedAt: new Date(Date.now() - 12 * DAY_MS),
        draftReply:
          "Thank you, Neha! So glad you loved the saree — we're already working on improving our packaging based on feedback like yours.",
        status: 'approved',
      },
    ])
    .onConflictDoNothing();

  console.warn(
    `Seeded dev user (${DEV_USER_ID}), brand (${DEV_BRAND_ID}), and a fixture Google connection with ${DEV_REVIEW_IDS.length} reviews.`,
  );
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
