import { z } from 'zod';

/**
 * The fixed, India-scoped category taxonomy the research pool (Layer A) is
 * organized by. Free-text `brands.category` / `brand_contexts.industry` never
 * carried a canonical vocabulary — every brand's own phrasing was fine for a
 * per-brand search query, but a *shared* pool needs brands to land in the same
 * bucket to actually share anything. See `ensureBrandCategoryKey` in
 * content-worker for how free text gets normalized into this.
 *
 * Deliberately small and flat rather than a nested/DB-driven taxonomy: the
 * whole point is a bounded set of pool "buckets" a scheduler can enumerate
 * without a due-index, and twelve categories already covers the brands this
 * platform has seen. `other` is the honest fallback for anything that does not
 * fit rather than a forced, wrong classification.
 */
export const categoryKeySchema = z.enum([
  'technology',
  'fashion_apparel',
  'food_beverage',
  'fitness_wellness',
  'sports',
  'entertainment',
  'beauty_personal_care',
  'home_lifestyle',
  'finance',
  'travel_hospitality',
  'education',
  'other',
]);
export type CategoryKey = z.infer<typeof categoryKeySchema>;

export const CATEGORY_KEYS = categoryKeySchema.options;

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  technology: 'Technology',
  fashion_apparel: 'Fashion & Apparel',
  food_beverage: 'Food & Beverage',
  fitness_wellness: 'Fitness & Wellness',
  sports: 'Sports',
  entertainment: 'Entertainment',
  beauty_personal_care: 'Beauty & Personal Care',
  home_lifestyle: 'Home & Lifestyle',
  finance: 'Finance',
  travel_hospitality: 'Travel & Hospitality',
  education: 'Education',
  other: 'General / Other',
};
