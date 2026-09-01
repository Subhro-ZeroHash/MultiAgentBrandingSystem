import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { campaignTypeSchema, outputFormatSchema, styleTemplateSchema } from './creative.js';
import { trendContentTypeSchema, trendSuggestedRequestSchema } from './trends.js';

/**
 * The Marketing Plan — the layer above individual trend opportunities.
 *
 * An opportunity answers "what could we post about right now?". A plan answers
 * "what are we doing for the next few weeks, and why?" — the thing a marketing
 * team keeps on a whiteboard and argues about. The distinction matters because
 * the two have different lifetimes and different owners: opportunities expire
 * with the news cycle and are produced entirely by the research agents, while a
 * plan persists, accumulates the user's steering, and is the thing they feel
 * ownership over.
 *
 * Three rules shape everything here:
 *
 * 1. **Proposing is cheap, generating is not.** One model call drafts a whole
 *    plan; each approved item costs real image spend. So the planner proposes
 *    freely and nothing is generated until a human approves that specific item.
 * 2. **Revision is replacement, not mutation.** Steering writes a new plan and
 *    supersedes the old one, so "what did my instruction actually change?"
 *    stays answerable.
 * 3. **A plan must be able to justify itself.** Every plan carries the evidence
 *    it was built from, because a recommendation the user cannot interrogate is
 *    one they cannot trust enough to approve.
 */

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * What the planner actually read.
 *
 * Ids rather than copies, except `notes`: the underlying opportunities and
 * intelligence items rotate out of the research pool on their own cadence, and
 * a plan that outlives its sources still has to explain itself. `notes` is the
 * planner's own short summary of each input, which is what survives.
 */
export const planEvidenceSchema = z.object({
  opportunityIds: z.array(entityIdSchema).default([]),
  intelligenceItemIds: z.array(entityIdSchema).default([]),
  /** Short human-readable lines: "Delhi Half Marathon, 14 Sep — high local
   *  search interest" — one per input the planner leaned on. */
  notes: z.array(z.string().max(400)).default([]),
  /** GEO visibility score at planning time, when one existed. Lets a later
   *  plan say "visibility rose 12 points since the last plan". */
  geoScoreAtPlanning: z.number().int().min(0).max(100).nullable().default(null),
});
export type PlanEvidence = z.infer<typeof planEvidenceSchema>;

// ---------------------------------------------------------------------------
// Plan + items
// ---------------------------------------------------------------------------

export const planStatusSchema = z.enum(['draft', 'active', 'superseded']);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planOriginSchema = z.enum(['scheduled', 'directive', 'manual']);
export type PlanOrigin = z.infer<typeof planOriginSchema>;

export const planItemStatusSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'generating',
  'ready',
  'scheduled',
  'published',
  'failed',
]);
export type PlanItemStatus = z.infer<typeof planItemStatusSchema>;

/** Statuses that still want a human. Backs the approval inbox's filter, and is
 *  defined once here so the API and the app cannot disagree about what
 *  "needs attention" means. */
export const PLAN_ITEM_AWAITING_USER: readonly PlanItemStatus[] = ['proposed'] as const;

export const planItemSchema = z.object({
  id: entityIdSchema,
  planId: entityIdSchema,
  brandId: entityIdSchema,
  sequence: z.number().int().min(0),
  title: z.string().min(3).max(160),
  rationale: z.string().min(3).max(1200),
  contentType: trendContentTypeSchema,
  suggestedRequest: trendSuggestedRequestSchema,
  productId: entityIdSchema.nullable(),
  opportunityId: entityIdSchema.nullable(),
  plannedFor: z.coerce.date().nullable(),
  status: planItemStatusSchema,
  generationJobId: entityIdSchema.nullable(),
  approvedAt: z.coerce.date().nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const marketingPlanSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  status: planStatusSchema,
  origin: planOriginSchema,
  horizonDays: z.number().int().min(1).max(90),
  headline: z.string().min(3).max(200),
  rationale: z.string().min(3).max(4000),
  focus: z.string().max(300).nullable(),
  evidence: planEvidenceSchema,
  supersedesId: entityIdSchema.nullable(),
  activatedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type MarketingPlan = z.infer<typeof marketingPlanSchema>;

/** A plan with its items, which is the only shape the app ever wants. */
export const planWithItemsSchema = marketingPlanSchema.extend({
  items: z.array(planItemSchema),
});
export type PlanWithItems = z.infer<typeof planWithItemsSchema>;

// ---------------------------------------------------------------------------
// What the planner model is asked to return
// ---------------------------------------------------------------------------

/**
 * Deliberately narrower than `planItemSchema`: the model supplies editorial
 * judgment (what to post and why), never identifiers, status, or timestamps.
 * Anything the system can determine for itself is not the model's to invent.
 */
export const plannedItemDraftSchema = z.object({
  title: z.string().min(3).max(160),
  rationale: z.string().min(10).max(1200),
  contentType: trendContentTypeSchema,
  /** Index into the opportunity list the planner was shown, when this item
   *  came from one. The planner sees positions, not UUIDs — asking a model to
   *  echo a UUID back correctly is a reliability problem with no upside. */
  opportunityIndex: z.number().int().min(0).nullable().default(null),
  /** Which product this is about, as an index into the catalog it was shown. */
  productIndex: z.number().int().min(0).nullable().default(null),
  /** Days from now. Relative because the model is bad at absolute dates and
   *  the system knows what "now" is. */
  dayOffset: z.number().int().min(0).max(90).nullable().default(null),
  /** The generation request this item becomes on approval. These mirror
   *  `trendSuggestedRequestSchema` field for field, because approval hands
   *  them straight to the existing generation pipeline — the planner is
   *  choosing the same knobs a user would choose on the create screen, so
   *  nothing new has to be taught to composeBrief. */
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  outputFormat: outputFormatSchema,
  headlineText: z.string().max(80).nullable().default(null),
  offerText: z.string().max(40).nullable().default(null),
  /** The creative angle in prose — what the post should actually show and
   *  say. Reaches composeBrief through `extraInstructions`. */
  angle: z.string().min(10).max(500),
});
export type PlannedItemDraft = z.infer<typeof plannedItemDraftSchema>;

export const planDraftSchema = z.object({
  headline: z.string().min(3).max(200),
  rationale: z.string().min(20).max(4000),
  focus: z.string().max(300).nullable().default(null),
  evidenceNotes: z.array(z.string().max(400)).max(12).default([]),
  items: z.array(plannedItemDraftSchema).min(1).max(10),
});
export type PlanDraft = z.infer<typeof planDraftSchema>;

// ---------------------------------------------------------------------------
// Directives — the steering chat
// ---------------------------------------------------------------------------

export const directiveRoleSchema = z.enum(['user', 'agent']);
export type DirectiveRole = z.infer<typeof directiveRoleSchema>;

export const directiveIntentSchema = z.enum([
  'redirect',
  'refine',
  'approve',
  'question',
  'unclear',
]);
export type DirectiveIntent = z.infer<typeof directiveIntentSchema>;

export const directiveStatusSchema = z.enum([
  'pending',
  'researching',
  'planning',
  'applied',
  'failed',
]);
export type DirectiveStatus = z.infer<typeof directiveStatusSchema>;

/**
 * How the directive agent reads one user message.
 *
 * `topic` is the part that does real work: on a redirect it becomes the search
 * query for a fresh research run, so it must be a standalone phrase — "100m
 * dash race in Delhi", not "that race" — because the researcher does not get
 * the conversation, only this string.
 */
export const directiveReadingSchema = z.object({
  intent: directiveIntentSchema,
  /** Self-contained search topic. Null unless the intent is `redirect`. */
  topic: z.string().max(300).nullable().default(null),
  /** What to keep from the current plan when refining. */
  adjustment: z.string().max(600).nullable().default(null),
  /** The reply shown in the chat. Written for the user, not for logs. */
  reply: z.string().min(3).max(1200),
});
export type DirectiveReading = z.infer<typeof directiveReadingSchema>;

export const planDirectiveSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  planId: entityIdSchema.nullable(),
  role: directiveRoleSchema,
  text: z.string().min(1).max(4000),
  intent: directiveIntentSchema.nullable(),
  status: directiveStatusSchema,
  resultingPlanId: entityIdSchema.nullable(),
  researchRunId: entityIdSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type PlanDirective = z.infer<typeof planDirectiveSchema>;

/** What the app posts to send a steering message. */
export const createDirectiveSchema = z.object({
  text: z.string().min(1).max(4000),
});
export type CreateDirectiveInput = z.infer<typeof createDirectiveSchema>;

// ---------------------------------------------------------------------------
// Approval inbox
// ---------------------------------------------------------------------------

/**
 * The single in-app surface for "things waiting on you".
 *
 * One flat, sorted feed rather than three separate screens, because the user's
 * question is "what needs me?", not "what needs me, per subsystem". The kind
 * discriminates what tapping it does.
 */
export const inboxItemKindSchema = z.enum([
  /** A proposed plan item; approving it starts generation. */
  'plan_item',
  /** Generated content waiting to be approved for publishing. */
  'scheduled_post',
  /** A time-sensitive trend the platform thinks is worth acting on now. */
  'opportunity',
  /** The agent replied in the planning chat and is waiting on the user. */
  'directive_reply',
]);
export type InboxItemKind = z.infer<typeof inboxItemKindSchema>;

export const inboxItemSchema = z.object({
  id: entityIdSchema,
  kind: inboxItemKindSchema,
  brandId: entityIdSchema,
  title: z.string(),
  /** One line of why this is being surfaced. */
  detail: z.string(),
  /** Higher sorts first. Computed server-side so every client orders the feed
   *  identically — see `inboxUrgency`. */
  urgency: z.number().int().min(0).max(100),
  createdAt: z.coerce.date(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

/**
 * Ranks the inbox.
 *
 * Deliberately a pure function of kind and age rather than anything
 * model-judged: the ordering of a to-do list is not a place where a
 * non-deterministic score earns its unpredictability, and a user who sees the
 * same list reorder itself between refreshes stops trusting it.
 *
 * Content that already cost money to generate outranks a proposal that has not,
 * because letting a generated post miss its slot wastes spend that is already
 * committed. Age breaks ties upward so nothing sits at the bottom forever.
 */
export function inboxUrgency(kind: InboxItemKind, createdAt: Date, now: Date = new Date()): number {
  const base: Record<InboxItemKind, number> = {
    scheduled_post: 70,
    directive_reply: 60,
    opportunity: 45,
    plan_item: 40,
  };
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  // Caps at +25 after roughly five days, so age nudges rather than dominates.
  const ageBoost = Math.min(25, Math.floor(ageHours / 5));
  return Math.min(100, base[kind] + ageBoost);
}
