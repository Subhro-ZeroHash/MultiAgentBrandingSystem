import { describeError, withRetry, withTimeout, type WebSearchResult } from '@bmas/ai';
import { and, desc, eq, getPlanningContext, recordFeedbackSignal, schema } from '@bmas/db';
import {
  directiveReadingSchema,
  type ContentPlanDirectiveJob,
  type CostEvent,
  type DirectiveReading,
} from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import { runPlanSynthesis } from './plan-synthesis.js';

/**
 * The steering agent — the one the user actually talks to.
 *
 * Everything in this system runs unattended until the user disagrees with it.
 * This file is what happens when they do: they type one sentence ("focus on the
 * 100m dash in Delhi instead"), and that sentence has to travel all the way
 * through the team — read correctly, researched from scratch because the topic
 * is new, and turned into a fresh plan — with no other input from them.
 *
 * The sequence is deliberately research-then-plan, not plan-then-research. A
 * planner asked about a topic it has no evidence for will confidently invent
 * some, and a plan built on invented facts is worse than no plan: it reads
 * exactly as authoritative as a real one. So a redirect always pays for a real
 * web search first, and the plan is drafted from what came back.
 *
 * Each stage writes its status onto the directive row as it goes, because a
 * redirect takes tens of seconds and "researching the 100m dash in Delhi" is a
 * far better thing to show than a spinner.
 */

const READING_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 45_000;
const RESEARCH_TIMEOUT_MS = 120_000;
const MAX_SEARCH_RESULTS = 8;
/** A user-named topic is usually an event or a moment, so bias hard toward
 *  recent coverage rather than whatever ranks best all-time. */
const RECENCY_DAYS = 30;

const READING_JSON_SCHEMA = z.toJSONSchema(directiveReadingSchema) as Record<string, unknown>;

const researchDigestSchema = z.object({
  /** What the searches established, in the planner's own words. */
  findings: z.array(z.string().min(5).max(400)).min(1).max(8),
  /** Whether the topic is real and has enough substance to plan around. */
  viable: z.boolean(),
  /** Said to the user when it is not. */
  concern: z.string().max(400).nullable().default(null),
});

/**
 * Processes one user message end to end.
 *
 * Never throws for an ordinary bad outcome — a directive that fails is recorded
 * as `failed` with a reply the user can read, because this is a chat, and an
 * exception that surfaces as a silent missing message is the worst possible
 * behaviour for one.
 */
export async function runPlanDirective(
  ctx: WorkerContext,
  job: ContentPlanDirectiveJob,
): Promise<void> {
  const [directive] = await ctx.db
    .select()
    .from(schema.planDirectives)
    .where(eq(schema.planDirectives.id, job.directiveId))
    .limit(1);
  if (!directive) throw new Error(`Directive ${job.directiveId} not found`);

  try {
    const reading = await readDirective(ctx, job.brandId, directive.text);

    await ctx.db
      .update(schema.planDirectives)
      .set({ intent: reading.intent })
      .where(eq(schema.planDirectives.id, directive.id));

    switch (reading.intent) {
      case 'redirect':
        await handleRedirect(ctx, job, directive.id, reading);
        return;
      case 'refine':
        await handleRefine(ctx, job, directive.id, reading);
        return;
      case 'approve':
        await handleApprove(ctx, job, directive.id, reading);
        return;
      // A question changes nothing; the reading already contains the answer.
      case 'question':
      case 'unclear':
        await reply(ctx, job, directive.id, reading.reply, 'applied');
        return;
    }
  } catch (error) {
    const message = describeError(error);
    console.error(`[plan-directive] directive ${directive.id} failed: ${message}`);
    await ctx.db
      .update(schema.planDirectives)
      .set({ status: 'failed', error: message })
      .where(eq(schema.planDirectives.id, directive.id));
    await reply(
      ctx,
      job,
      directive.id,
      "I couldn't work that through just now. Try sending it again, or rephrase it.",
      'applied',
    );
  }
}

/**
 * Reads one message against the plan it is about.
 *
 * The current plan goes into the prompt because almost every real message is
 * relative to it — "make it less about the sale", "that second one is wrong" —
 * and a classifier that cannot see the plan has to guess what "that" means.
 */
async function readDirective(
  ctx: WorkerContext,
  brandId: string,
  text: string,
): Promise<DirectiveReading> {
  const context = await getPlanningContext(ctx.db, brandId);

  const { value: reading, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson(
        {
          role: 'orchestrator',
          system:
            'You read one message from a business owner about their marketing plan and decide ' +
            'what they want. Classify it:\n' +
            '- redirect: they want the plan to be about a different subject. Set `topic` to a ' +
            'self-contained search phrase for that subject — it is handed to a web search that ' +
            'does not see this conversation, so "the 100m dash race in Delhi", never "that race".\n' +
            '- refine: same subject, different treatment (tone, format, channel, cadence). Put ' +
            'what to change in `adjustment`.\n' +
            '- approve: they are saying yes to the plan as it stands.\n' +
            '- question: they asked something. Answer it in `reply` using the plan below.\n' +
            '- unclear: you genuinely cannot tell. Ask one specific clarifying question.\n\n' +
            'Write `reply` as the message they will read in the chat: plain, direct, no ' +
            'preamble, no restating their own message back at them. If you are about to go ' +
            'research something, say so in one line.',
          messages: [
            {
              role: 'user',
              content: [
                `Business: ${context.identity.brandName}${
                  context.identity.industry ? `, ${context.identity.industry}` : ''
                }${context.identity.location ? `, based in ${context.identity.location}` : ''}.`,
                context.currentPlanHeadline
                  ? `Current plan: "${context.currentPlanHeadline}"\nItems: ${
                      context.currentPlanTitles.join('; ') || 'none yet'
                    }`
                  : 'There is no plan yet.',
                '',
                `Their message: "${text}"`,
              ].join('\n'),
            },
          ],
          schema: READING_JSON_SCHEMA,
          parse: (raw) => directiveReadingSchema.parse(raw),
        },
        { referenceId: brandId, brandId },
      ),
      READING_TIMEOUT_MS,
      'plan-directive:read',
    ),
  );

  await recordCost(ctx, brandId, cost, 'content:plan-directive-read');
  return reading;
}

/**
 * The headline path: research the new subject, then re-plan around it.
 */
async function handleRedirect(
  ctx: WorkerContext,
  job: ContentPlanDirectiveJob,
  directiveId: string,
  reading: DirectiveReading,
): Promise<void> {
  const topic = reading.topic?.trim();
  if (!topic) {
    await reply(
      ctx,
      job,
      directiveId,
      'Tell me what to focus on instead and I will research it and redo the plan.',
      'applied',
    );
    return;
  }

  // Acknowledge before the slow part, so the chat shows intent immediately.
  //
  // Composed here rather than taken from `reading.reply`: this line is the
  // only feedback during a slow step, and a weak model happily returns the
  // single word "researching" for it. The model's own wording is still used
  // where it is genuinely answering something.
  await reply(
    ctx,
    job,
    directiveId,
    `Researching ${topic} — I'll rebuild the plan around it and show you what changed.`,
    'researching',
  );

  // What the user chose to steer toward is one of the strongest preference
  // signals this system ever gets — far stronger than an inferred one. Filed
  // as a chosen direction rather than a rejection, since it says what they
  // DO want.
  await recordFeedbackSignal(ctx.db, {
    brandId: job.brandId,
    kind: 'variant_selected',
    type: 'topic',
    summary: `The owner asked to focus on "${topic}"`,
    value: topic,
    detail: { source: 'plan-directive', directiveId },
  });

  const run = await runDirectedResearch(ctx, job.brandId, topic, directiveId);

  await ctx.db
    .update(schema.planDirectives)
    .set({ status: 'planning', researchRunId: run.runId })
    .where(eq(schema.planDirectives.id, directiveId));

  if (!run.viable) {
    await reply(
      ctx,
      job,
      directiveId,
      run.concern ??
        `I couldn't find enough about "${topic}" to build a plan on. Want me to try a different angle?`,
      'applied',
    );
    return;
  }

  const planId = await runPlanSynthesis(ctx, {
    brandId: job.brandId,
    directiveId,
    focus: topic,
    horizonDays: 14,
  });

  // Only the plan link here; `reply` below is what marks the directive applied,
  // after its message exists.
  await ctx.db
    .update(schema.planDirectives)
    .set({ resultingPlanId: planId })
    .where(eq(schema.planDirectives.id, directiveId));

  await reply(
    ctx,
    job,
    directiveId,
    planId
      ? `Done — the plan is now built around ${topic}. ${run.findings[0] ?? ''} Nothing is generated yet; approve the items you want.`.trim()
      : `I researched ${topic} but there wasn't enough in your account to plan from yet. Add a product and I'll try again.`,
    'applied',
  );
}

/** Same subject, different treatment: no new research needed, so re-plan with
 *  the adjustment folded into the focus line. */
async function handleRefine(
  ctx: WorkerContext,
  job: ContentPlanDirectiveJob,
  directiveId: string,
  reading: DirectiveReading,
): Promise<void> {
  await reply(ctx, job, directiveId, reading.reply, 'planning');

  const [current] = await ctx.db
    .select({ focus: schema.marketingPlans.focus })
    .from(schema.marketingPlans)
    .where(
      and(
        eq(schema.marketingPlans.brandId, job.brandId),
        eq(schema.marketingPlans.status, 'active'),
      ),
    )
    .limit(1);

  const adjustment = reading.adjustment ?? reading.reply;
  await recordFeedbackSignal(ctx.db, {
    brandId: job.brandId,
    kind: 'edited',
    summary: `The owner asked for: ${adjustment}`,
    detail: { source: 'plan-directive', directiveId },
  });

  const focus = current?.focus ? `${current.focus} — ${adjustment}` : adjustment;
  const planId = await runPlanSynthesis(ctx, {
    brandId: job.brandId,
    directiveId,
    focus: focus.slice(0, 300),
    horizonDays: 14,
  });

  await ctx.db
    .update(schema.planDirectives)
    .set({ resultingPlanId: planId })
    .where(eq(schema.planDirectives.id, directiveId));

  await reply(ctx, job, directiveId, 'Updated the plan with that.', 'applied');
}

/**
 * "Yes, do it" said in the chat.
 *
 * Records the approval as a preference but does NOT approve the items: bulk
 * approval by conversation is exactly the path by which an ambiguous sentence
 * turns into unintended image spend. The user approves items individually,
 * where each one shows what it will cost them.
 */
async function handleApprove(
  ctx: WorkerContext,
  job: ContentPlanDirectiveJob,
  directiveId: string,
  reading: DirectiveReading,
): Promise<void> {
  // Existence, not a count: the reply only branches on whether anything is
  // still awaiting the user. Selecting `id` and aliasing it `count` read as if
  // it returned a number, which it never did.
  const [awaiting] = await ctx.db
    .select({ id: schema.planItems.id })
    .from(schema.planItems)
    .where(
      and(eq(schema.planItems.brandId, job.brandId), eq(schema.planItems.status, 'proposed')),
    )
    .limit(1);

  await recordFeedbackSignal(ctx.db, {
    brandId: job.brandId,
    kind: 'approved',
    summary: 'The owner approved the direction of the current plan',
    detail: { source: 'plan-directive', directiveId },
  });

  await reply(
    ctx,
    job,
    directiveId,
    awaiting
      ? `${reading.reply} Tap approve on the items you want made — each one starts a generation, so I won't do it for you.`
      : reading.reply,
    'applied',
  );
}

/**
 * Real web search on a user-named topic, then a short digest.
 *
 * This is the piece the trend pool cannot provide: the pool is refreshed per
 * category on its own cadence, so a specific event the user just named is
 * almost never in it. The run is recorded in `trend_research_runs` with its
 * `focus` set, which is what makes user-directed research distinguishable from
 * the autonomous kind in the history.
 */
async function runDirectedResearch(
  ctx: WorkerContext,
  brandId: string,
  topic: string,
  directiveId: string,
): Promise<{ runId: string; findings: string[]; viable: boolean; concern: string | null }> {
  const [run] = await ctx.db
    .insert(schema.trendResearchRuns)
    .values({ brandId, status: 'running', focus: topic, startedAt: new Date() })
    .returning({ id: schema.trendResearchRuns.id });
  if (!run) throw new Error('Directed research run insert returned no row');

  const context = await getPlanningContext(ctx.db, brandId);
  const results = await search(ctx, run.id, topic);

  if (results.length === 0) {
    await ctx.db
      .update(schema.trendResearchRuns)
      .set({ status: 'failed', error: 'No search results', finishedAt: new Date() })
      .where(eq(schema.trendResearchRuns.id, run.id));
    return {
      runId: run.id,
      findings: [],
      viable: false,
      concern: `I searched for "${topic}" and found nothing usable.`,
    };
  }

  // Evidence is stored before it is interpreted, matching how the trend
  // pipeline treats signals: the sources outlive whatever the model made of
  // them, so a later plan can still be audited.
  await ctx.db.insert(schema.trendSignals).values(
    results.slice(0, MAX_SEARCH_RESULTS).map((r) => ({
      runId: run.id,
      source: 'web',
      signalType: 'directed',
      topic,
      // `title` is nullable on a search result but not on a signal — the URL
      // is the honest fallback, and a signal with no identity at all is
      // useless for auditing later.
      title: r.title ?? r.url,
      snippet: r.snippet,
      sourceUrl: r.url,
      // Directed results are not comparatively scored the way pool signals
      // are; a flat mid strength records "this is evidence" without implying
      // a ranking that was never computed.
      strength: 50,
      // Stored as the provider's own ISO string: the column is text, because
      // providers disagree about format and a failed parse should not lose
      // the date entirely.
      publishedAt: r.publishedAt,
    })),
  );

  const { value: digest, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson(
        {
          role: 'orchestrator',
          system:
            'You are a researcher briefing a marketing planner. From the search results, state ' +
            'what is actually established about this topic — dates, location, who cares, why it ' +
            'matters commercially. Facts only, from the results; do not pad with what you ' +
            'already believe. Set viable false only if the results show the topic is not real, ' +
            'or is too thin to plan marketing around.',
          messages: [
            {
              role: 'user',
              content: [
                `Topic: ${topic}`,
                `Brand: ${context.identity.brandName}${
                  context.identity.industry ? ` (${context.identity.industry})` : ''
                }${context.identity.location ? `, in ${context.identity.location}` : ''}`,
                '',
                'Search results:',
                ...results
                  .slice(0, MAX_SEARCH_RESULTS)
                  .map((r, i) => `[${i}] ${r.title} — ${r.snippet ?? ''} (${r.url})`),
              ].join('\n'),
            },
          ],
          schema: z.toJSONSchema(researchDigestSchema) as Record<string, unknown>,
          parse: (raw) => researchDigestSchema.parse(raw),
        },
        { referenceId: run.id, brandId },
      ),
      RESEARCH_TIMEOUT_MS,
      'plan-directive:digest',
    ),
  );

  await recordCost(ctx, brandId, cost, 'content:plan-directed-research');

  await ctx.db
    .update(schema.trendResearchRuns)
    .set({ status: digest.viable ? 'succeeded' : 'failed', finishedAt: new Date() })
    .where(eq(schema.trendResearchRuns.id, run.id));

  console.warn(
    `[plan-directive] directive ${directiveId}: researched "${topic}" — ${results.length} result(s), viable=${digest.viable}`,
  );

  return {
    runId: run.id,
    findings: digest.findings,
    viable: digest.viable,
    concern: digest.concern,
  };
}

/** Every configured provider, tolerating individual failures — the same
 *  "one failing doesn't sink the run" rule the pool refresh uses. */
async function search(
  ctx: WorkerContext,
  runId: string,
  topic: string,
): Promise<WebSearchResult[]> {
  const providers = ctx.ai.configuredWebSearches();
  const out: WebSearchResult[] = [];

  for (const provider of providers) {
    try {
      const { value: results, cost } = await withRetry(() =>
        withTimeout(
          provider.search(
            {
              // No `locale`. Providers disagree about what belongs there —
              // Tavily rejects anything that is not a country name, and a
              // brand's location is usually a city — so a redirect was
              // burning one failed provider call every time. The place is
              // already in the topic ("the 100m dash race in Delhi"), which
              // is the part that actually steers the results.
              query: topic,
              recencyDays: RECENCY_DAYS,
              maxResults: MAX_SEARCH_RESULTS,
              topic: 'general',
            },
            { referenceId: runId },
          ),
          SEARCH_TIMEOUT_MS,
          `directed search (${provider.provider})`,
        ),
      );
      await recordCost(ctx, null, cost, 'content:plan-directed-search', runId);
      out.push(...results);
    } catch (error) {
      console.warn(
        `[plan-directive] ${provider.provider} search failed for "${topic}": ${describeError(error)}`,
      );
    }
  }

  return out;
}

/** Appends the agent's side of the conversation. */
async function reply(
  ctx: WorkerContext,
  job: ContentPlanDirectiveJob,
  parentDirectiveId: string,
  text: string,
  status: 'researching' | 'planning' | 'applied',
): Promise<void> {
  const [plan] = await ctx.db
    .select({ id: schema.marketingPlans.id })
    .from(schema.marketingPlans)
    .where(
      and(
        eq(schema.marketingPlans.brandId, job.brandId),
        eq(schema.marketingPlans.status, 'active'),
      ),
    )
    .orderBy(desc(schema.marketingPlans.createdAt))
    .limit(1);

  // Insert the reply BEFORE flipping the parent's status.
  //
  // The client stops polling once the user's directive reads `applied`, so
  // writing the status first opens a window where a poll sees "finished" and
  // no reply — the final message then never appears until a manual refresh.
  // Doing it in this order means any poll that observes the terminal status
  // also observes the message that goes with it.
  await ctx.db.insert(schema.planDirectives).values({
    brandId: job.brandId,
    planId: plan?.id ?? null,
    role: 'agent',
    text,
    status: 'applied',
  });

  await ctx.db
    .update(schema.planDirectives)
    .set({ status })
    .where(eq(schema.planDirectives.id, parentDirectiveId));
}

/** CLAUDE.md rule 5. `brandId` is nullable because a search cost belongs to a
 *  run, and the ledger keeps rows whose brand later disappears. */
async function recordCost(
  ctx: WorkerContext,
  brandId: string | null,
  cost: CostEvent,
  operation: string,
  referenceId?: string,
): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: referenceId ?? brandId ?? 'plan-directive',
    provider: cost.provider,
    model: cost.model,
    operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}
