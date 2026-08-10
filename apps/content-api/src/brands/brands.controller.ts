import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  createBrandKitSchema,
  createProductSchema,
  preferenceTypeSchema,
  updateAutomationSettingsSchema,
  updateBrandContextSchema,
  updateBrandKitSchema,
  type PreferenceType,
  type UpdateAutomationSettingsInput,
  type UpdateBrandContextInput,
  type UpdateBrandKitInput,
} from '@bmas/shared';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AutomationSettingsService } from './automation-settings.service.js';
import { BrandContextService } from './brand-context.service.js';
import { BrandPreferencesService } from './brand-preferences.service.js';
import { BrandsService } from './brands.service.js';

/** Upload contract for a product reference photo. Kept local to content-api
 *  rather than in @bmas/shared: it is an intake shape, not a cross-workstream
 *  entity, and the GEO side never sends one. */
const productImageUploadSchema = z.object({
  base64: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  isPrimary: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
type ProductImageUploadInput = z.infer<typeof productImageUploadSchema>;

@UseGuards(JwtAuthGuard)
@Controller('brands')
export class BrandsController {
  constructor(
    private readonly brands: BrandsService,
    private readonly context: BrandContextService,
    private readonly preferences: BrandPreferencesService,
    private readonly automation: AutomationSettingsService,
  ) {}

  @Get()
  list(@Request() req: AuthenticatedRequest) {
    return this.brands.listForOwner(req.user.id);
  }

  /**
   * Every brand's Brand Brain, condensed — the account-wide "what does the
   * platform know about us?" view.
   *
   * Declared above `@Get(':id')` deliberately. Nest matches routes in
   * declaration order, so the parameterised route would otherwise swallow this
   * one and try to load a brand whose id is the literal string "context".
   */
  @Get('context')
  listContexts(@Request() req: AuthenticatedRequest) {
    return this.context.listContextSummaries(req.user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.brands.findOne(id, req.user.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateBrandKitSchema)) body: unknown,
  ) {
    return this.brands.update(id, req.user.id, body as UpdateBrandKitInput);
  }

  @Post()
  create(
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createBrandKitSchema)) body: unknown,
  ) {
    return this.brands.create(req.user.id, body as Parameters<BrandsService['create']>[1]);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.brands.remove(id, req.user.id);
  }

  // -------------------------------------------------------------------------
  // Brand Brain (1.9)
  //
  // The persistent per-brand understanding the autonomous loop reads from.
  // Everything here is brand-scoped and ownership-checked in the services.
  // -------------------------------------------------------------------------

  /** Everything known about the brand, assembled — what the Brand Brain screen
   *  renders. Creates the context and settings rows on first read, so a brand
   *  made before this feature existed answers like any other. */
  @Get(':id/context')
  getContext(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.context.buildFullBrandContext(id, req.user.id);
  }

  /** User edits from the review screen. Field-by-field: omitting a field leaves
   *  it alone. Send `confirm: true` to mark the context human-owned, which stops
   *  the website importer from writing to it. */
  @Patch(':id/context')
  updateContext(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateBrandContextSchema)) body: unknown,
  ) {
    return this.context.updateContext(id, req.user.id, body as UpdateBrandContextInput);
  }

  /** Re-derives context from the applied website import. Named `refresh`
   *  rather than `import` because it does not fetch anything — it reuses the
   *  reading already stored, so re-running it costs nothing and hits nobody's
   *  server a second time. */
  @Post(':id/context/refresh')
  refreshContext(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.context.refreshFromSiteProfile(id, req.user.id);
  }

  /** What an agent was actually told, newest first. Forensics for a run that
   *  produced something off-brand. */
  @Get(':id/context/snapshots')
  listSnapshots(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.context.listSnapshots(id, req.user.id);
  }

  /** Current learned preferences — the newest observation per type, above the
   *  confidence floor. Pass `?type=` to narrow to one dimension; for how that
   *  belief has moved over time, use the `/history` route below. */
  @Get(':id/preferences')
  listPreferences(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Query('type') type?: string,
  ) {
    const ownerId = req.user.id;
    if (!type) return this.preferences.listForOwner(id, ownerId);

    // Through the pipe rather than a bare `.parse`, which throws a raw ZodError
    // that Nest has no mapping for and reports as a 500 — an unknown query
    // string is the caller's mistake, not the server's.
    const parsed = new ZodValidationPipe(preferenceTypeSchema).transform(type) as PreferenceType;
    return this.preferences.listForOwner(id, ownerId, parsed);
  }

  /**
   * How one belief has moved, oldest first — every observation, not just the
   * current one.
   *
   * The whole reason `brand_preferences` is append-only: a confidence curve
   * that climbs is worth acting on, one that oscillates is noise, and a single
   * current row cannot tell them apart. Without this route that distinction was
   * stored and never readable.
   */
  @Get(':id/preferences/:type/history')
  preferenceHistory(
    @Param('id') id: string,
    @Param('type') type: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const parsed = new ZodValidationPipe(preferenceTypeSchema).transform(type) as PreferenceType;
    return this.preferences.historyForOwner(id, req.user.id, parsed);
  }

  @Get(':id/automation-settings')
  getAutomationSettings(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.automation.getSettings(id, req.user.id);
  }

  @Patch(':id/automation-settings')
  updateAutomationSettings(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateAutomationSettingsSchema)) body: unknown,
  ) {
    return this.automation.updateSettings(id, req.user.id, body as UpdateAutomationSettingsInput);
  }

  @Get(':id/products')
  listProducts(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.brands.listProducts(id, req.user.id);
  }

  @Post(':id/products')
  createProduct(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createProductSchema.omit({ brandId: true }))) body: unknown,
  ) {
    return this.brands.createProduct(
      {
        ...(body as Omit<Parameters<BrandsService['createProduct']>[0], 'brandId'>),
        brandId: id,
      },
      req.user.id,
    );
  }

  @Post(':id/products/:productId/images')
  addProductImage(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(productImageUploadSchema)) body: unknown,
  ) {
    return this.brands.addProductImage(id, productId, req.user.id, body as ProductImageUploadInput);
  }
}
