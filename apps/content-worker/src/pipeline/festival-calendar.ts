import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult } from '@bmas/ai';
import { schema } from '@bmas/db';
import { marketName, type CostEvent } from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import { dateGrounding, isoDateInMarket, todayInMarket } from './prompt-context.js';

/**
 * The upcoming-observances calendar behind the national trend bucket.
 *
 * Web search cannot answer "what festivals are coming up". It is built to rank
 * pages by relevance to a phrase, and no page says "here is what is happening
 * in the next six weeks" — so a query for it returns SEO sale listicles, whose
 * dates are whenever the article was written. That is the actual mechanism
 * behind the Republic Day complaint: the national bucket asked search a
 * question search has no answer to, and dutifully synthesised opportunities
 * out of the marketing copy it got back. Tightening the query text or the date
 * filter cannot fix it, because the missing thing is not recency — it is a
 * calendar.
 *
 * A calendar is exactly the sort of thing a language model does hold: which
 * observances a country keeps, and roughly when they fall. What it holds
 * unreliably is the *exact date in a given year* — most of the interesting
 * ones (Raksha Bandhan, Eid, Easter, Diwali) track lunar or computed calendars
 * and move by weeks year to year, and a model asked for a date it half-knows
 * will produce a confident wrong one.
 *
 * So the two halves are used for what each is good at, in the order that makes
 * the weakness of one the input to the strength of the other:
 *
 *   1. **Enumerate** (model). Ask which observances fall in the window. This
 *      is recall, not lookup — the thing the model is genuinely good at, and
 *      the thing search cannot do at all.
 *   2. **Verify** (search). Ask about each one *by name*. "Raksha Bandhan 2026
 *      date" is a named-entity query with a real answer on real pages —
 *      precisely the shape search is built for, and the exact query the
 *      enumeration step has just made possible to write.
 *   3. **Reconcile** (model, reading the pages). Search proves the event is
 *      real but says nothing about whether *our* date for it is. Two
 *      consecutive live runs placed Onam three days out and thirty-two days
 *      out — the drift is not hypothetical, and an opportunity built on the
 *      wrong date is worse than none, because it looks authoritative. The
 *      pages found in step 2 almost always state the date in so many words,
 *      so this reads them back and corrects the estimate. Cheap: one call for
 *      the whole calendar, not one per event.
 *
 * An event that survives all three is real, correctly dated, and carries live
 * URLs.
 * An event that no targeted search corroborates is dropped: either the model
 * invented it, or it is too obscure to have coverage worth building a campaign
 * on. Same "the model proposes, search disposes" contract as
 * `verifyCompetitorSources` in intelligence-research.ts, and it preserves the
 * pipeline's standing rule that nothing reaches a pool item without a source
 * behind it.
 *
 * Nothing here is specific to any one country or festival. The market code is
 * whatever `market-classifier.ts` derived from the client's own stated
 * location, and every observance comes from the model reading that code —
 * there is no festival list in this repo to fall out of date.
 */

const ENUMERATE_TIMEOUT_MS = 60_000;
/** Higher than the 15s the trend searches use. These queries are named-entity
 *  lookups rather than broad topic searches, and SerpApi is measurably slower
 *  on them — three of nine timed out at 15s on the first live run, each one an
 *  event that then had only Tavily standing between it and being dropped as
 *  uncorroborated. */
const SEARCH_TIMEOUT_MS = 25_000;
/**
 * Generous because the budget is not spent only on the answer.
 *
 * The orchestrator model reasons before it emits, and that reasoning is
 * charged against the same ceiling — so a list that measures ~1,500 tokens of
 * JSON can still be cut off mid-string, which is what happened on the third
 * live run: truncated at position 459, inside the first event's `significance`.
 * Retrying cannot help, since the retry gets the same budget and stops in the
 * same place; only headroom fixes it. Same failure the GEO probe analysis hit,
 * and the same remedy.
 */
const MAX_ENUMERATE_TOKENS = 8_000;

/**
 * How far ahead to look, and why it is not shorter.
 *
 * Content for a festival has to be planned, approved and scheduled before the
 * day itself, so the useful horizon is the planning lead time, not the event
 * window. Six weeks lets a major festival appear while there is still time to
 * build a campaign around it, and is comfortably wider than the 24h pool
 * cadence so nothing can slip through between two refreshes.
 */
export const CALENDAR_HORIZON_DAYS = 45;

/** Verification is one search per event, so the count is a direct cost
 *  multiplier on every national refresh. Enough to cover a dense festival
 *  season without turning one bucket refresh into fifty searches. */
export const MAX_CALENDAR_EVENTS = 12;

const VERIFY_RESULTS_PER_EVENT = 4;

export interface CalendarEvent {
  name: string;
  /** ISO `YYYY-MM-DD`. Date-only on purpose: an observance is a calendar day
   *  in its own market, not an instant, and giving it a timezone would invite
   *  exactly the off-by-one this module exists to avoid. */
  date: string;
  kind: 'religious' | 'national' | 'cultural' | 'commercial' | 'seasonal';
  significance: string;
  audience: string;
}

/** A calendar event that survived verification, with the results that
 *  corroborated it. */
export interface VerifiedCalendarEvent extends CalendarEvent {
  results: WebSearchResult[];
  daysAway: number;
}

const calendarEventSchema = z.object({
  name: z.string().trim().min(1).max(120),
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO YYYY-MM-DD date'),
  kind: z.enum(['religious', 'national', 'cultural', 'commercial', 'seasonal']),
  significance: z.string().trim().max(400),
  audience: z.string().trim().max(200),
});

const calendarEnumerationSchema = z.object({ events: z.array(calendarEventSchema) });

const ENUMERATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'date', 'kind', 'significance', 'audience'],
        properties: {
          name: {
            type: 'string',
            description:
              "The observance's common name in this market, as people there actually say it. " +
              'No year, no "festival of" preamble.',
          },
          date: {
            type: 'string',
            description:
              'The date it falls on THIS year, as YYYY-MM-DD. For an observance spanning several ' +
              'days, give the main or first day. Give your best answer even if you are unsure — ' +
              'a later step verifies every date against live sources, so an approximate date is ' +
              'far more useful here than omitting the event.',
          },
          kind: {
            enum: ['religious', 'national', 'cultural', 'commercial', 'seasonal'],
            description:
              'commercial covers retail moments with no older origin (a shopping-festival sale ' +
              'window); seasonal covers weather- or calendar-driven moments (monsoon, back to ' +
              'school) that are not a single dated holiday.',
          },
          significance: {
            type: 'string',
            description:
              'What people in this market actually DO for it — the customs, gifting, spending or ' +
              'gathering behaviour a business could speak to. Not a history lesson. One or two ' +
              'sentences, at most 200 characters.',
          },
          audience: {
            type: 'string',
            description:
              'Who observes it — the whole country, one region, one faith community, one age ' +
              'group. Say so plainly; a national holiday and a regional one are not the same ' +
              'marketing opportunity. A short phrase, at most 100 characters.',
          },
        },
      },
    },
  },
} as const;

/** Whole days from `from` to `date`, both read as calendar days. Negative for
 *  a date already past. */
export function daysBetween(from: string, date: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Drops anything outside the window, deterministically.
 *
 * The prompt asks for the window, but a prompt is a request and this is the
 * guarantee — the same belt-and-braces split as `dropStaleResults` against
 * SerpApi's `tbs` filter. Models reliably drift here in one specific way: asked
 * for the next six weeks they volunteer the year's *famous* festivals, which is
 * how a well-known past holiday gets back in after all the date-grounding work.
 * Today itself counts as upcoming — a festival is an opportunity on the day.
 */
export function filterToHorizon(
  events: CalendarEvent[],
  today: string,
  horizonDays: number = CALENDAR_HORIZON_DAYS,
): Array<CalendarEvent & { daysAway: number }> {
  return events
    .map((event) => ({ ...event, daysAway: daysBetween(today, event.date) }))
    .filter((event) => !Number.isNaN(event.daysAway))
    .filter((event) => event.daysAway >= 0 && event.daysAway <= horizonDays)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, MAX_CALENDAR_EVENTS);
}

/**
 * The targeted query for one event — the whole reason enumeration runs first.
 *
 * Naming the event turns an unanswerable question ("what is coming up") into
 * an ordinary one ("when is this, and what are brands doing for it"), and the
 * year pins it to this occurrence rather than a decade of past coverage.
 *
 * No `recencyDays`: coverage of a festival two weeks out is written in the
 * weeks around it, and a date filter narrow enough to be worth setting would
 * cut the explainer pages that carry the date we are checking. The year in the
 * query text does that job without discarding anything.
 */
export function buildCalendarVerificationQuery(
  event: CalendarEvent,
  market: string,
): WebSearchRequest {
  const year = event.date.slice(0, 4);
  return {
    query: `${event.name} ${year} date ${marketName(market)} celebrations campaigns`,
    topic: 'general',
    maxResults: VERIFY_RESULTS_PER_EVENT,
  };
}

async function recordCost(ctx: WorkerContext, runId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId: null,
    system: 'content',
    referenceId: runId,
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

/** Step 1 — recall. What does this market observe in the window? */
async function enumerateCalendarEvents(
  ctx: WorkerContext,
  runId: string,
  market: string,
  now: Date,
): Promise<Array<CalendarEvent & { daysAway: number }>> {
  const today = isoDateInMarket(market, now);
  const place = marketName(market);

  const { value, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson<{ events: CalendarEvent[] }>(
        {
          role: 'orchestrator',
          system:
            dateGrounding(market, now) +
            `You are a calendar reference for ${place}. You are asked only which observances ` +
            `fall in a window — not to judge, rank or market them. Another step does that.\n\n` +
            'List what people in this market actually observe: religious festivals, public and ' +
            'national holidays, regional observances, established commercial moments, and ' +
            'seasonal turns that shape what people buy. Include an observance kept by a large ' +
            'community even when it is not a public holiday, and say who keeps it in `audience`.\n\n' +
            'Many observances follow lunar or computed calendars and move by weeks between ' +
            'years, so give the date for the year in question rather than the one you remember ' +
            'best. Do not adjust a date to look plausible — an honest approximate date is ' +
            'checked and corrected downstream, a smoothed-over one is not.\n\n' +
            'Completeness matters more than confidence: an observance you leave out cannot be ' +
            'recovered later, while a wrong one is dropped when nothing corroborates it.',
          messages: [
            {
              role: 'user',
              content:
                `Today is ${today} (${todayInMarket(market, now)}) in ${place}.\n\n` +
                `List every observance falling between ${today} and ${CALENDAR_HORIZON_DAYS} ` +
                `days after it. Order them by date, earliest first. Exclude anything before ` +
                `${today} — it has already happened.`,
            },
          ],
          maxTokens: MAX_ENUMERATE_TOKENS,
          schema: ENUMERATE_SCHEMA as unknown as Record<string, unknown>,
          parse: (raw) => calendarEnumerationSchema.parse(raw),
        },
        { referenceId: runId },
      ),
      ENUMERATE_TIMEOUT_MS,
      'calendar enumeration',
    ),
  );

  await recordCost(ctx, runId, cost);
  return filterToHorizon(value.events, today);
}

const RECONCILE_TIMEOUT_MS = 60_000;
/** Sized for the reasoning, not the answer — same trap as
 *  MAX_ENUMERATE_TOKENS above. The reply is a dozen `{index, date}` pairs and
 *  measures a couple of hundred tokens, but comparing each estimate against
 *  three excerpts is the actual work, and it is charged here too. 2,000 was
 *  not enough for ten events and truncated mid-JSON on the fourth live run. */
const MAX_RECONCILE_TOKENS = 8_000;
/** Enough of each page for the date to appear in it; a date is stated early or
 *  not at all, and the whole calendar's excerpts share one prompt. */
const MAX_EXCERPT_CHARS = 300;
const EXCERPTS_PER_EVENT = 3;

const reconcileSchema = z.object({
  events: z.array(
    z.object({
      index: z.number().int().min(0),
      date: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO YYYY-MM-DD date'),
    }),
  ),
});

const RECONCILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'date'],
        properties: {
          index: {
            type: 'integer',
            description: 'The [N] number of the observance this is the date for.',
          },
          date: {
            type: 'string',
            description:
              'The date the excerpts actually support, as YYYY-MM-DD. If they state a date, use ' +
              'theirs even when it contradicts the estimate — they are live pages and the estimate ' +
              'is a guess. If they state none, repeat the estimate unchanged. Never split the ' +
              'difference between two dates.',
          },
        },
      },
    },
  },
} as const;

function describeEventsForReconcile(events: VerifiedCalendarEvent[]): string {
  return events
    .map((event, index) => {
      const excerpts = event.results
        .slice(0, EXCERPTS_PER_EVENT)
        .map((result) => {
          const title = result.title?.trim() || result.url;
          const body = result.snippet.slice(0, MAX_EXCERPT_CHARS).trim();
          return `    - ${title}${body ? `: ${body}` : ''}`;
        })
        .join('\n');
      return `[${index}] ${event.name} — estimated ${event.date}\n${excerpts}`;
    })
    .join('\n\n');
}

/**
 * Applies the model's corrections, then re-checks the window.
 *
 * Re-checking matters: a date corrected by a month can land outside the
 * horizon, and an event that is no longer upcoming has to go — that is the
 * whole point of correcting it. An index the model omits or invents leaves its
 * event on the estimated date rather than dropping it, since a missing
 * correction is not evidence the estimate was wrong.
 *
 * Pure and exported so the precedence rules can be pinned without a model call.
 */
export function applyReconciledDates(
  events: VerifiedCalendarEvent[],
  corrections: Array<{ index: number; date: string }>,
  today: string,
  horizonDays: number = CALENDAR_HORIZON_DAYS,
): VerifiedCalendarEvent[] {
  const byIndex = new Map<number, string>();
  for (const { index, date } of corrections) {
    if (index >= 0 && index < events.length && !byIndex.has(index)) byIndex.set(index, date);
  }

  return events
    .map((event, index) => {
      const date = byIndex.get(index) ?? event.date;
      return { ...event, date, daysAway: daysBetween(today, date) };
    })
    .filter((event) => !Number.isNaN(event.daysAway))
    .filter((event) => event.daysAway >= 0 && event.daysAway <= horizonDays)
    .sort((a, b) => a.daysAway - b.daysAway);
}

/** Step 3 — reconciliation. Reads the corroborating pages back and corrects
 *  any date the enumeration guessed wrong. Never throws: a failed
 *  reconciliation leaves the estimates in place, which is where they were
 *  before this step existed. */
async function reconcileCalendarDates(
  ctx: WorkerContext,
  runId: string,
  market: string,
  events: VerifiedCalendarEvent[],
  now: Date,
): Promise<VerifiedCalendarEvent[]> {
  const today = isoDateInMarket(market, now);
  try {
    const { value, cost } = await withTimeout(
      ctx.ai.llm().generateJson<z.infer<typeof reconcileSchema>>(
        {
          role: 'volume',
          system:
            `Today is ${today} in ${marketName(market)}. You are checking dates, nothing else.\n\n` +
            'Each observance below carries an estimated date and excerpts from live pages about ' +
            'it. Read the excerpts and give the date they actually support. Many of these follow ' +
            'lunar or computed calendars and shift by weeks between years, so an estimate being ' +
            'confidently stated is no evidence it is right.\n\n' +
            'The excerpts outrank the estimate whenever they state a date. Only when they state ' +
            'none does the estimate stand. Return one entry per observance, using its [N] number.',
          messages: [{ role: 'user', content: describeEventsForReconcile(events) }],
          maxTokens: MAX_RECONCILE_TOKENS,
          schema: RECONCILE_SCHEMA as unknown as Record<string, unknown>,
          parse: (raw) => reconcileSchema.parse(raw),
        },
        { referenceId: runId },
      ),
      RECONCILE_TIMEOUT_MS,
      'calendar date reconciliation',
    );
    await recordCost(ctx, runId, cost);

    const reconciled = applyReconciledDates(events, value.events, today);
    for (const event of reconciled) {
      const before = events.find((e) => e.name === event.name);
      if (before && before.date !== event.date) {
        console.warn(
          `[festival-calendar] run ${runId}: corrected ${event.name} from ${before.date} to ${event.date} against its sources`,
        );
      }
    }
    return reconciled;
  } catch (error) {
    console.warn(
      `[festival-calendar] run ${runId}: date reconciliation failed, keeping estimated dates — ${describeError(error)}`,
    );
    return events;
  }
}

/**
 * Step 2 — corroboration. Keeps an event only when a search about it by name
 * actually returns something.
 *
 * Pure and exported so the keep/drop rule can be pinned without a network
 * call, the same split `verifyCompetitorSources` gets.
 */
export function keepCorroborated(
  events: Array<CalendarEvent & { daysAway: number }>,
  resultsByEvent: Map<string, WebSearchResult[]>,
): VerifiedCalendarEvent[] {
  return events
    .map((event) => ({ ...event, results: resultsByEvent.get(event.name) ?? [] }))
    .filter((event) => event.results.length > 0);
}

async function verifyCalendarEvents(
  ctx: WorkerContext,
  runId: string,
  market: string,
  events: Array<CalendarEvent & { daysAway: number }>,
): Promise<VerifiedCalendarEvent[]> {
  const providers = ctx.ai.configuredWebSearches();
  const resultsByEvent = new Map<string, WebSearchResult[]>();

  // One event failing must not sink the others, and one provider failing must
  // not sink an event another provider could still corroborate — the same
  // allSettled shape `collectPoolSignals` uses, for the same reason.
  await Promise.all(
    events.map(async (event) => {
      const request = buildCalendarVerificationQuery(event, market);
      const settled = await Promise.allSettled(
        providers.map(async (provider) => {
          const { value, cost } = await withTimeout(
            provider.search(request, { referenceId: runId }),
            SEARCH_TIMEOUT_MS,
            `calendar verification (${provider.provider}/${event.name})`,
          );
          await recordCost(ctx, runId, cost);
          return value;
        }),
      );

      const results: WebSearchResult[] = [];
      const seen = new Set<string>();
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          console.warn(
            `[festival-calendar] verification search failed for "${event.name}" in run ${runId}: ${describeError(outcome.reason)}`,
          );
          continue;
        }
        for (const result of outcome.value) {
          if (seen.has(result.url)) continue;
          seen.add(result.url);
          results.push(result);
        }
      }
      if (results.length) resultsByEvent.set(event.name, results);
    }),
  );

  return keepCorroborated(events, resultsByEvent);
}

/**
 * Renders the confirmed calendar as a dated agenda for the synthesis prompt.
 *
 * `daysAway` is spelled out rather than left as a date to subtract, because
 * that number is the whole basis of the `freshness` score and of judging
 * whether there is still time to make something — and arithmetic is the one
 * thing a model reliably gets wrong when it could instead just read the answer.
 */
export function describeCalendarForPrompt(events: VerifiedCalendarEvent[]): string {
  if (events.length === 0) return '';
  return events
    .map((event) => {
      const when =
        event.daysAway === 0
          ? 'TODAY'
          : event.daysAway === 1
            ? 'TOMORROW'
            : `in ${event.daysAway} days`;
      return (
        `- **${event.name}** — ${event.date} (${when}), ${event.kind}\n` +
        `  Observed by: ${event.audience}\n` +
        `  What happens: ${event.significance}`
      );
    })
    .join('\n');
}

/**
 * The whole two-step pass, for the national bucket.
 *
 * Never throws. A failed calendar leaves the bucket exactly as it was before
 * this module existed — the broad search still runs and still produces items —
 * so a bad enumeration degrades the run rather than failing it.
 */
export async function loadUpcomingCalendar(
  ctx: WorkerContext,
  runId: string,
  market: string,
  now: Date = new Date(),
): Promise<VerifiedCalendarEvent[]> {
  try {
    const enumerated = await enumerateCalendarEvents(ctx, runId, market, now);
    if (enumerated.length === 0) {
      console.warn(
        `[festival-calendar] run ${runId}: no observances enumerated for ${marketName(market)} in the next ${CALENDAR_HORIZON_DAYS} days`,
      );
      return [];
    }
    console.warn(
      `[festival-calendar] run ${runId}: enumerated ${enumerated.length} observance(s) for ${marketName(market)} — ${enumerated.map((e) => `${e.name} (+${e.daysAway}d)`).join(', ')}`,
    );

    const verified = await verifyCalendarEvents(ctx, runId, market, enumerated);
    const dropped = enumerated.filter((e) => !verified.some((v) => v.name === e.name));
    if (dropped.length) {
      console.warn(
        `[festival-calendar] run ${runId}: dropped ${dropped.length} uncorroborated observance(s) — ${dropped.map((e) => e.name).join(', ')}`,
      );
    }
    if (verified.length === 0) return [];

    const reconciled = await reconcileCalendarDates(ctx, runId, market, verified, now);
    console.warn(
      `[festival-calendar] run ${runId}: ${reconciled.length} observance(s) confirmed — ${reconciled.map((e) => `${e.name} ${e.date} (+${e.daysAway}d)`).join(', ')}`,
    );
    return reconciled;
  } catch (error) {
    console.error(
      `[festival-calendar] run ${runId}: calendar unavailable, falling back to search-only signals — ${describeError(error)}`,
    );
    return [];
  }
}
