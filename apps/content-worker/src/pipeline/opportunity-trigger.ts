import { withRetry, withTimeout } from '@bmas/ai';
import { eq, schema, type Brand, type NewTrendOpportunityRow } from '@bmas/db';
import {
  QUEUES,
  contentConceptSynthesisSchema,
  creativeRequestSchema,
  type AutoTriggeredJobRef,
  type ContentConcept,
  type CostEvent,
  type CreativeRequest,
  type TrendSuggestedRequest,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';

/** `NewTrendOpportunityRow`'s `id` is optional at the insert-type level
 *  (it has a `$defaultFn`), but every caller of this module already
 *  generated one explicitly before insert — narrowed here so the rest of
 *  the file can use `opportunity.id` without an undefined check that would
 *  never actually trigger. */
export type TriggerableOpportunity = NewTrendOpportunityRow & { id: string };

/**
 * Trend Opportunity Engine — auto-trigger.
 *
 * The last stage of the pipeline described in trend-research.ts's header:
 * once an opportunity is judged `immediate_action`, this turns it into real
 * content with no human step in between (the "fully automatic through to
 * generated assets" design) — a Content Strategy Agent call that produces 3
 * distinct concepts, each becoming its own `CreativeRequest` and
 * `generationJobs` row, enqueued onto the same `contentGeneration` queue a
 * normal user-initiated generation uses. The image-generation pipeline
 * itself (composeBrief/generateImages/qaImages/generateCopy) is untouched —
 * these are ordinary generation jobs from the worker's point of view.
 *
 * Called from exactly one place: `maybeAutoTriggerBestOpportunity` in
 * trend-research.ts, itself gated on the brand's
 * `automation_settings.autoTriggerHighScoreOpportunities` opt-in and capped
 * at one opportunity per run. See that file for the guardrails; this file
 * assumes the caller already decided triggering is appropriate.
 */

const STRATEGY_TIMEOUT_MS = 300_000;
const MAX_STRATEGY_TOKENS = 3_000;

const CONTENT_CONCEPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts'],
  properties: {
    concepts: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'label',
          'postConcept',
          'captionText',
          'hashtags',
          'ctaText',
          'visualDirection',
          'outputFormat',
        ],
        properties: {
          label: {
            type: 'string',
            description: 'Short name for this concept, e.g. "30-Day Running Challenge Kickoff".',
          },
          postConcept: { type: 'string', description: 'What the post actually shows or does.' },
          captionText: { type: 'string', description: 'The caption copy for this post.' },
          hashtags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relevant hashtags, without the # symbol.',
          },
          ctaText: { type: 'string', description: 'Short call to action, e.g. "Shop Now".' },
          visualDirection: {
            type: 'string',
            description: 'Composition, mood, what should be in frame.',
          },
          outputFormat: {
            type: 'string',
            enum: ['instagram_post', 'story_reel_cover', 'facebook_banner', 'poster_a4'],
            description:
              'Which format best fits this concept. The 3 concepts must use 3 DIFFERENT formats.',
          },
        },
      },
    },
  },
} as const;

async function recordCost(
  ctx: WorkerContext,
  brandId: string,
  opportunityId: string,
  cost: CostEvent,
): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: opportunityId,
    provider: cost.provider,
    model: cost.model,
    operation: cost.operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    imageCount: cost.imageCount ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}

interface ProductForPrompt {
  name: string;
  description: string | null;
  sellingPoints: string[];
}

/**
 * The Content Strategy Agent: given one opportunity and the product it was
 * matched to, produces exactly 3 content concepts across 3 different
 * formats — "Concept 1 → Poster, Concept 2 → Reel idea, Concept 3 → Story"
 * from the product brief, with the model choosing which format best fits
 * each angle rather than a fixed mapping.
 */
async function generateContentConcepts(
  ctx: WorkerContext,
  opportunity: TriggerableOpportunity,
  brand: Brand,
  product: ProductForPrompt,
): Promise<{ concepts: ContentConcept[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson<{ concepts: ContentConcept[] }>(
        {
          role: 'orchestrator',
          system:
            'You are a content strategist. Given one high-priority marketing opportunity for a ' +
            'small business and the specific product it should promote, produce exactly 3 distinct ' +
            'content concepts that turn this opportunity into real posts — not 3 rephrasings of the ' +
            'same idea, 3 genuinely different angles (e.g. a bold announcement, a behind-the-scenes ' +
            'angle, a direct offer). Each concept must specify its own best-fit format; the 3 must ' +
            'use 3 different formats.' +
            (brand.bannedTopics.length
              ? ` Never suggest content touching: ${brand.bannedTopics.join(', ')} — under any framing.`
              : ''),
          messages: [
            {
              role: 'user',
              content: [
                `**Brand:** ${brand.name}${brand.category ? ` (${brand.category})` : ''}`,
                `**Tone:** ${brand.tone.join(', ') || 'friendly'}`,
                '',
                `**The opportunity:** ${opportunity.title}`,
                opportunity.summary,
                `Recommendation: ${opportunity.recommendation}`,
                '',
                `**The product to promote:** ${product.name}`,
                product.description ?? '',
                product.sellingPoints.length
                  ? `Selling points: ${product.sellingPoints.join(', ')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          maxTokens: MAX_STRATEGY_TOKENS,
          schema: CONTENT_CONCEPT_SCHEMA as unknown as Record<string, unknown>,
          parse: (raw) => contentConceptSynthesisSchema.parse(raw),
        },
        { brandId: brand.id, referenceId: opportunity.id },
      ),
      STRATEGY_TIMEOUT_MS,
      'content concept strategy',
    ),
  );

  return { concepts: value.concepts, cost };
}

/** Only reads `suggestedRequest` off the opportunity — narrower than
 *  `TriggerableOpportunity` so this stays a pure function callers (and
 *  tests) can use without constructing a full opportunity row. */
export function buildCreativeRequest(
  opportunity: { suggestedRequest: TrendSuggestedRequest },
  brandId: string,
  productId: string,
  concept: ContentConcept,
): CreativeRequest {
  return creativeRequestSchema.parse({
    brandId,
    productId,
    campaignType: opportunity.suggestedRequest.campaignType,
    styleTemplate: opportunity.suggestedRequest.styleTemplate,
    outputFormat: concept.outputFormat,
    headlineText: concept.label,
    offerText: opportunity.suggestedRequest.offerText ?? concept.ctaText,
    extraInstructions: [
      concept.postConcept,
      `Visual direction: ${concept.visualDirection}`,
      concept.hashtags.length
        ? `Hashtags: ${concept.hashtags.map((tag) => `#${tag}`).join(' ')}`
        : '',
      `Caption: ${concept.captionText}`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 500),
    variantMode: 'uniform',
    variantCount: 1,
  });
}

/** Generation starts this long before the post's publish slot — mirrors
 *  `GENERATION_LEAD_MS` in `scheduling.service.ts` so an auto-triggered post
 *  gets the same review window as a manually scheduled one. */
const GENERATION_LEAD_MS = 2 * 60 * 60 * 1000;

export async function triggerAutoOpportunity(
  ctx: WorkerContext,
  opportunity: TriggerableOpportunity,
  brand: Brand,
  contentGenerationQueue: Queue,
  scheduledPostPublishQueue: Queue,
): Promise<void> {
  if (opportunity.autoTriggered) return;
  if (!opportunity.productId) {
    console.warn(
      `[opportunity-trigger] opportunity ${opportunity.id} has no matched product, skipping auto-trigger`,
    );
    return;
  }

  const [product] = await ctx.db
    .select({
      name: schema.products.name,
      description: schema.products.description,
      sellingPoints: schema.products.sellingPoints,
    })
    .from(schema.products)
    .where(eq(schema.products.id, opportunity.productId))
    .limit(1);
  if (!product) {
    console.warn(
      `[opportunity-trigger] opportunity ${opportunity.id}'s matched product ${opportunity.productId} no longer exists, skipping`,
    );
    return;
  }

  console.warn(
    `[opportunity-trigger] opportunity ${opportunity.id}: generating content concepts...`,
  );
  const { concepts, cost } = await generateContentConcepts(ctx, opportunity, brand, product);
  await recordCost(ctx, brand.id, opportunity.id, cost);

  // Each concept becomes its own single-post scheduled_campaign rather than a
  // bare generation job. That's what puts it through the same
  // pending_generation -> pending_approval -> approved -> posted pipeline (and
  // the same approval-queue UI) that a manually created campaign gets — a
  // bare generation job has no scheduled_posts row, so onGenerationSucceeded
  // has nothing to flip to pending_approval and the creative never surfaces
  // for review. The 3 concepts intentionally use 3 different output formats
  // (see generateContentConcepts), and scheduled_campaigns has one
  // outputFormat per row, so 3 concepts means 3 one-post campaigns, not one
  // 3-post campaign.
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + GENERATION_LEAD_MS);

  const jobRefs: AutoTriggeredJobRef[] = [];
  for (const [index, concept] of concepts.entries()) {
    const request = buildCreativeRequest(opportunity, brand.id, opportunity.productId, concept);
    const idempotencyKey = `auto-trend-${opportunity.id}-${index}`;

    const [campaign] = await ctx.db
      .insert(schema.scheduledCampaigns)
      .values({
        brandId: request.brandId,
        productId: request.productId,
        campaignType: request.campaignType,
        styleTemplate: request.styleTemplate,
        outputFormat: request.outputFormat,
        totalDays: 1,
        postsPerDay: 1,
        startAt: scheduledFor,
      })
      .returning();
    if (!campaign) {
      throw new Error(
        `Failed to insert scheduled campaign for concept ${index} of opportunity ${opportunity.id}`,
      );
    }

    const [job] = await ctx.db
      .insert(schema.generationJobs)
      .values({
        brandId: request.brandId,
        productId: request.productId,
        idempotencyKey,
        campaignType: request.campaignType,
        styleTemplate: request.styleTemplate,
        outputFormat: request.outputFormat,
        request,
      })
      .returning();
    if (!job) {
      await ctx.db
        .delete(schema.scheduledCampaigns)
        .where(eq(schema.scheduledCampaigns.id, campaign.id));
      throw new Error(
        `Failed to insert generation job for concept ${index} of opportunity ${opportunity.id}`,
      );
    }

    const [post] = await ctx.db
      .insert(schema.scheduledPosts)
      .values({
        campaignId: campaign.id,
        brandId: request.brandId,
        productId: request.productId,
        scheduledFor,
        status: 'pending_generation',
        generationJobId: job.id,
        caption: concept.captionText,
      })
      .returning();
    if (!post) {
      await ctx.db.delete(schema.generationJobs).where(eq(schema.generationJobs.id, job.id));
      await ctx.db
        .delete(schema.scheduledCampaigns)
        .where(eq(schema.scheduledCampaigns.id, campaign.id));
      throw new Error(
        `Failed to insert scheduled post for concept ${index} of opportunity ${opportunity.id}`,
      );
    }

    try {
      await contentGenerationQueue.add(
        QUEUES.contentGeneration,
        { jobId: job.id, brandId: job.brandId, idempotencyKey },
        {
          jobId: idempotencyKey,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
      // Deterministic id matching SchedulingService.enqueuePublish, so
      // cancellation elsewhere can find this job by scheduled-post id alone.
      await scheduledPostPublishQueue.add(
        QUEUES.scheduledPostPublish,
        { scheduledPostId: post.id },
        {
          jobId: post.id,
          delay: Math.max(0, scheduledFor.getTime() - now.getTime()),
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      );
    } catch (error) {
      // Same reasoning as GenerationsService.enqueue: an uncommitted row with
      // no queued job would wedge the idempotency check forever.
      await ctx.db.delete(schema.scheduledPosts).where(eq(schema.scheduledPosts.id, post.id));
      await ctx.db.delete(schema.generationJobs).where(eq(schema.generationJobs.id, job.id));
      await ctx.db
        .delete(schema.scheduledCampaigns)
        .where(eq(schema.scheduledCampaigns.id, campaign.id));
      throw error;
    }

    jobRefs.push({ jobId: job.id, label: concept.label, outputFormat: concept.outputFormat });
  }

  await ctx.db
    .update(schema.trendOpportunities)
    .set({
      autoTriggered: true,
      autoTriggeredAt: new Date(),
      generationJobIds: jobRefs,
      status: 'working_on',
    })
    .where(eq(schema.trendOpportunities.id, opportunity.id));

  console.warn(
    `[opportunity-trigger] opportunity ${opportunity.id}: triggered ${jobRefs.length} generation jobs: ${jobRefs.map((ref) => ref.jobId).join(', ')}`,
  );
}
