import { NotFoundException } from '@nestjs/common';
import { eq, schema, type Database } from '@bmas/db';

/**
 * Every GEO route is brand-scoped but the brand row itself lives in
 * content-api's `core` schema, so this re-checks ownership on every request
 * rather than trusting the caller's `brandId` — without it, any authenticated
 * user could read or drive tracked-prompt probes for a brand they don't own.
 * Mirrors `BrandsService.assertBrandOwned` in content-api; 404 rather than 403
 * so a brand's existence isn't leaked to a non-owner.
 */
export async function assertBrandOwned(
  db: Database,
  brandId: string,
  ownerId: string,
): Promise<void> {
  const [brand] = await db
    .select({ ownerId: schema.brands.ownerId })
    .from(schema.brands)
    .where(eq(schema.brands.id, brandId))
    .limit(1);

  if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
  if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
}
