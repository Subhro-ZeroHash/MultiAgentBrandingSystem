import { describeError, withRetry, withTimeout } from '@bmas/ai';
import {
  and,
  desc,
  eq,
  getTrendContext,
  inArray,
  schema,
} from '@bmas/db';
import type { AdOptimizationJob } from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';

const OPTIMIZE_TIMEOUT_MS = 60_000;

const recommendationItemSchema = z.object({
  campaignId: z.string().nullable().optional(),
  suggestionType: z.enum(['budget_shift', 'keyword_add', 'creative_swap', 'bid_adjustment']),
  reasoning: z.string().min(10),
  impactEstimate: z.string(),
  actionPayload: z
    .object({
      fromPlatform: z.string().optional(),
      toPlatform: z.string().optional(),
      budgetShiftPct: z.number().optional(),
      amount: z.number().optional(),
      keywordsToAdd: z.array(z.string()).optional(),
      keywordsToRemove: z.array(z.string()).optional(),
      creativeRecommendation: z.string().optional(),
    })
    .optional(),
});

const outputSchema = z.object({
  recommendations: z.array(recommendationItemSchema),
});
type OptimizationOutput = z.infer<typeof outputSchema>;

const OUTPUT_JSON_SCHEMA = z.toJSONSchema(outputSchema) as Record<string, unknown>;

const SYSTEM_PROMPT = [
  'You are an expert Performance Marketing Specialist and Growth Director for retail and e-commerce brands.',
  'Your objective is to continuously audit ad spend, ROAS (Return on Ad Spend), and keyword allocations across Google, Meta (Instagram/Facebook), and X.',
  'You evaluate three critical context layers:',
  '  1. Past Ad Data: Current active campaigns, daily budgets, spend to date, ROAS, and targeted keywords.',
  '  2. Competitor Strategy: Competitor movements, pricing shifts, and audience targeting patterns.',
  '  3. Trending Search Keywords: High-volume, rising search queries in the category.',
  'Formulate 2 to 4 high-impact, actionable optimizations.',
  'Ensure suggestions fall into one of: budget_shift, keyword_add, creative_swap, or bid_adjustment.',
  'Reasoning must explicitly cite numbers, ROAS comparisons, named competitors, or trending search spikes.',
  'Keep impactEstimate clear and quantitative (e.g. "+0.4x Blended ROAS", "+22% High-Intent Search Clicks", "Est. 15% lower CAC").',
].join('\n');

/**
 * Runs the AI Ad Optimization pipeline for a given brand.
 * Analyzes active cross-platform ad campaigns against competitor moves and trending topics,
 * queries the Gemini orchestrator model, and writes recommendations to `content.ad_optimizations`.
 */
export async function runAdOptimization(
  ctx: WorkerContext,
  data: AdOptimizationJob,
): Promise<{ count: number }> {
  const { brandId } = data;

  // 1. Fetch Past Ad Campaigns
  const activeCampaigns = await ctx.db
    .select()
    .from(schema.adCampaigns)
    .where(and(eq(schema.adCampaigns.brandId, brandId), eq(schema.adCampaigns.status, 'active')));

  // If brand has no ad campaigns yet, seed standard baseline campaigns so the agent can optimize
  let campaigns = activeCampaigns;
  if (campaigns.length === 0) {
    const brand = await ctx.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);

    const brandName = brand[0]?.name ?? 'Brand';

    const baselineCampaigns = [
      {
        id: crypto.randomUUID(),
        brandId,
        platform: 'google',
        campaignName: `${brandName} Search - High Intent`,
        status: 'active',
        dailyBudget: 40,
        spendToDate: 820,
        roas: 3.8,
        keywords: [`${brandName.toLowerCase()} online`, 'premium ethnic boutique', 'festive wear shop'],
      },
      {
        id: crypto.randomUUID(),
        brandId,
        platform: 'meta',
        campaignName: `${brandName} Instagram Reels - Conversions`,
        status: 'active',
        dailyBudget: 50,
        spendToDate: 1250,
        roas: 2.4,
        keywords: ['festive fashion', 'trending reels wear', 'traditional clothing'],
      },
      {
        id: crypto.randomUUID(),
        brandId,
        platform: 'x',
        campaignName: `${brandName} Trend Amplification`,
        status: 'active',
        dailyBudget: 15,
        spendToDate: 290,
        roas: 1.2,
        keywords: ['artisan craft', 'handmade clothing', 'support artisans'],
      },
    ];

    await ctx.db.insert(schema.adCampaigns).values(baselineCampaigns);
    campaigns = await ctx.db
      .select()
      .from(schema.adCampaigns)
      .where(eq(schema.adCampaigns.brandId, brandId));
  }

  // 2. Fetch Brand Context & Competitor Data
  const trendContext = await getTrendContext(ctx.db, brandId);

  const intelligenceRuns = await ctx.db
    .select({ id: schema.intelligenceRuns.id })
    .from(schema.intelligenceRuns)
    .where(eq(schema.intelligenceRuns.brandId, brandId))
    .orderBy(desc(schema.intelligenceRuns.createdAt))
    .limit(2);

  const intelligenceItems =
    intelligenceRuns.length > 0
      ? await ctx.db
          .select({
            title: schema.intelligenceItems.title,
            summary: schema.intelligenceItems.summary,
            whyItMatters: schema.intelligenceItems.whyItMatters,
          })
          .from(schema.intelligenceItems)
          .where(inArray(schema.intelligenceItems.runId, intelligenceRuns.map((r) => r.id)))
          .limit(5)
      : [];

  // 3. Fetch Trending Keywords / Opportunities
  const trendRuns = await ctx.db
    .select({ id: schema.trendResearchRuns.id })
    .from(schema.trendResearchRuns)
    .where(eq(schema.trendResearchRuns.brandId, brandId))
    .orderBy(desc(schema.trendResearchRuns.createdAt))
    .limit(2);

  const trendOpportunities =
    trendRuns.length > 0
      ? await ctx.db
          .select({
            title: schema.trendOpportunities.title,
            summary: schema.trendOpportunities.summary,
            score: schema.trendOpportunities.score,
          })
          .from(schema.trendOpportunities)
          .where(inArray(schema.trendOpportunities.runId, trendRuns.map((r) => r.id)))
          .limit(6)
      : [];

  // Build the Prompt Payload
  const campaignsPrompt = campaigns
    .map(
      (c) =>
        `- Campaign ID: "${c.id}" | Name: "${c.campaignName}" | Platform: [${c.platform.toUpperCase()}] | ` +
        `Daily Budget: $${c.dailyBudget} | Spend to date: $${c.spendToDate} | ROAS: ${c.roas}x | ` +
        `Keywords: ${c.keywords.join(', ')}`,
    )
    .join('\n');

  const competitorsPrompt =
    trendContext.competitors.length > 0
      ? trendContext.competitors.map((comp) => `- ${comp.name}${comp.note ? ` (${comp.note})` : ''}`).join('\n')
      : 'No explicitly configured competitors.';

  const intelligencePrompt =
    intelligenceItems.length > 0
      ? intelligenceItems.map((item) => `- ${item.title}: ${item.whyItMatters}`).join('\n')
      : 'No recent market intelligence alerts.';

  const trendsPrompt =
    trendOpportunities.length > 0
      ? trendOpportunities.map((t) => `- "${t.title}" (Relevance Score: ${t.score}): ${t.summary}`).join('\n')
      : 'Category keywords: festive ethnic wear, handloom fashion, bridal boutique.';

  const userPrompt = [
    `BRAND: ${trendContext.identity.brandName} (${trendContext.identity.industry || 'Retail'})`,
    `LOCATION & AUDIENCE: ${trendContext.identity.location || 'India'} | ${trendContext.identity.audience || 'General'}`,
    '',
    'ACTIVE AD CAMPAIGNS ACROSS PLATFORMS (PAST PERFORMANCE DATA):',
    campaignsPrompt,
    '',
    'COMPETITOR STRATEGY & MARKET FINDINGS:',
    competitorsPrompt,
    '',
    'RECENT MARKET INTELLIGENCE SIGNALS:',
    intelligencePrompt,
    '',
    'CURRENT TRENDING TOPICS & KEYWORDS:',
    trendsPrompt,
    '',
    'Evaluate the performance gaps and provide 2 to 4 high-impact ad optimizations.',
    'For each recommendation, assign campaignId from the active campaigns above if applicable (or null if cross-platform).',
  ].join('\n');

  // 4. Query the Orchestrator LLM
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<OptimizationOutput>(
          {
            role: 'orchestrator',
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
            schema: OUTPUT_JSON_SCHEMA,
            parse: (raw: unknown) => outputSchema.parse(raw),
          },
          { referenceId: brandId, brandId },
        ),
        OPTIMIZE_TIMEOUT_MS,
        'ad-optimization:synthesis',
      ),
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          `[ad-optimization] brand ${brandId}: attempt ${attempt} failed, retrying in ${delayMs}ms — ${describeError(error)}`,
        ),
    },
  );

  // CLAUDE.md rule 5: Every provider call records cost to `core.cost_events`
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: brandId,
    provider: cost.provider,
    model: cost.model,
    operation: 'content:ad-optimization',
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });

  // 5. Save Recommendations to `content.ad_optimizations`
  const validCampaignIds = new Set(campaigns.map((c) => c.id));

  const rowsToInsert = value.recommendations.map((rec) => ({
    id: crypto.randomUUID(),
    brandId,
    campaignId: rec.campaignId && validCampaignIds.has(rec.campaignId) ? rec.campaignId : null,
    suggestionType: rec.suggestionType,
    reasoning: rec.reasoning,
    impactEstimate: rec.impactEstimate,
    actionPayload: (rec.actionPayload as Record<string, unknown>) ?? null,
    status: 'proposed' as const,
  }));

  if (rowsToInsert.length > 0) {
    await ctx.db.insert(schema.adOptimizations).values(rowsToInsert);
  }

  return { count: rowsToInsert.length };
}
