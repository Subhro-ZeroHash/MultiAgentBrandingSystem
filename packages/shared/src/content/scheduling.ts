import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { campaignTypeSchema, outputFormatSchema, styleTemplateSchema } from './creative.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const DEFAULT_WINDOW_START_HOUR = 9;
export const DEFAULT_WINDOW_END_HOUR = 21;

/**
 * How soon after "now" the first slot may fall.
 *
 * Not an arbitrary buffer: everything between creation and publishing has to
 * fit inside it. Generation itself runs up to a few minutes (longer for a 4K
 * print format, and the worker only runs two at a time), and then a human has
 * to actually see the notification and approve. Anything tighter schedules
 * posts that cannot physically be reviewed in time, and an unreviewed post
 * expires rather than publishing.
 */
const MIN_LEAD_MS = 45 * MS_PER_MINUTE;

/** Cap on how far skipping may push a campaign past its nominal length. Only
 *  reachable via a back-dated `startAt`; a campaign starting now skips at most
 *  the remainder of today. Bounds the scan so a very old `startAt` terminates. */
const MAX_SKIPPED_DAYS = 30;

export interface ComputeScheduleSlotsInput {
  startAt: Date;
  totalDays: number;
  postsPerDay: number;
  now?: Date;
  windowStartHour?: number;
  windowEndHour?: number;
}

/**
 * Spreads `totalDays * postsPerDay` publish times evenly across a fixed daily
 * window (09:00-21:00 UTC by default), one calendar day at a time starting
 * from `startAt`'s date. A deliberate v1 simplification: the window is UTC,
 * not the brand's local timezone.
 *
 * Slots that are already past — or too close to now to generate and review in
 * time — are **skipped**, and the schedule runs on into later days until the
 * requested number of posts is placed. The count and the cadence are what the
 * user asked for; which calendar days they land on is what gives.
 *
 * The alternative, compressing stale slots forward to "now", is what this
 * replaced: a campaign created at 20:00 turned four of that day's five slots
 * into posts one minute apart, which is both a spam burst and unreviewable —
 * generation alone outlasts the gap, so they expired instead of publishing.
 */
export function computeScheduleSlots(input: ComputeScheduleSlotsInput): Date[] {
  const {
    startAt,
    totalDays,
    postsPerDay,
    now = new Date(),
    windowStartHour = DEFAULT_WINDOW_START_HOUR,
    windowEndHour = DEFAULT_WINDOW_END_HOUR,
  } = input;

  if (totalDays < 1) throw new Error('totalDays must be at least 1');
  if (postsPerDay < 1) throw new Error('postsPerDay must be at least 1');
  if (windowEndHour <= windowStartHour) {
    throw new Error('windowEndHour must be after windowStartHour');
  }

  const windowSpanMs = (windowEndHour - windowStartHour) * MS_PER_HOUR;
  const dayStart = Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate());
  const wanted = totalDays * postsPerDay;
  const earliestAllowed = now.getTime() + MIN_LEAD_MS;

  // Bounded so a startAt far enough in the past cannot spin here forever: the
  // schedule may roll past its nominal length, but only by the days it skipped.
  const maxDaysToScan = totalDays + MAX_SKIPPED_DAYS;

  const slots: Date[] = [];
  for (let day = 0; day < maxDaysToScan && slots.length < wanted; day++) {
    const dayWindowStart = dayStart + day * MS_PER_DAY + windowStartHour * MS_PER_HOUR;

    for (let i = 0; i < postsPerDay && slots.length < wanted; i++) {
      // A single post per day sits at the window's midpoint rather than its
      // open, which would otherwise cluster every campaign's first post at
      // exactly the window start hour.
      const offset = postsPerDay === 1 ? windowSpanMs / 2 : (windowSpanMs * i) / (postsPerDay - 1);
      const slot = dayWindowStart + offset;

      // Skipped, not clamped — see the note on this function.
      if (slot < earliestAllowed) continue;
      slots.push(new Date(slot));
    }
  }

  return slots;
}

/** FR: "give source material once, then say how long and how often" — the
 *  product and its brief/style/format are fixed for the whole campaign; only
 *  cadence varies. */
export const createScheduledCampaignSchema = z.object({
  productId: entityIdSchema,
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  outputFormat: outputFormatSchema,
  totalDays: z.number().int().min(1).max(14),
  postsPerDay: z.number().int().min(1).max(10),
  /** Defaults to now when omitted — the common case is "start today". */
  startAt: z.coerce.date().optional(),
});
export type CreateScheduledCampaignInput = z.infer<typeof createScheduledCampaignSchema>;

export const approveScheduledPostSchema = z.object({
  accountId: entityIdSchema.optional(),
  caption: z.string().min(1).max(2200).optional(),
});
export type ApproveScheduledPostInput = z.infer<typeof approveScheduledPostSchema>;

/**
 * Editing a campaign after it starts. Every field is optional — the client
 * sends only what changed.
 *
 * Cadence changes only re-plan the part of the campaign that has not been
 * generated yet; posts already made, approved, or published keep their slots,
 * because a user who has reviewed a post does not expect editing the schedule
 * to throw that work away.
 */
export const updateScheduledCampaignSchema = z
  .object({
    campaignType: campaignTypeSchema.optional(),
    styleTemplate: styleTemplateSchema.optional(),
    outputFormat: outputFormatSchema.optional(),
    totalDays: z.number().int().min(1).max(14).optional(),
    postsPerDay: z.number().int().min(1).max(10).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });
export type UpdateScheduledCampaignInput = z.infer<typeof updateScheduledCampaignSchema>;

/** Editing one planned post without approving it: retime it, or fix the copy
 *  and destination while leaving it awaiting review. */
export const updateScheduledPostSchema = z
  .object({
    scheduledFor: z.coerce.date().optional(),
    accountId: entityIdSchema.optional(),
    caption: z.string().min(1).max(2200).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });
export type UpdateScheduledPostInput = z.infer<typeof updateScheduledPostSchema>;

/** Query filter for the review queue. Kept as a schema rather than a cast so a
 *  bad value is a 400 from validation, not a 500 from Postgres rejecting an
 *  unknown enum label. */
export const scheduledPostStatusSchema = z.enum([
  'pending_generation',
  'pending_approval',
  'approved',
  'publishing',
  'rejected',
  'posted',
  'failed',
  'expired',
]);
export type ScheduledPostStatusFilter = z.infer<typeof scheduledPostStatusSchema>;
