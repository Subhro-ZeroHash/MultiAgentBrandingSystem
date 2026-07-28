import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { campaignTypeSchema, outputFormatSchema, styleTemplateSchema } from './creative.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const DEFAULT_WINDOW_START_HOUR = 9;
export const DEFAULT_WINDOW_END_HOUR = 21;

/** How far past "now" a slot that would otherwise land in the past gets
 *  bumped to, so a campaign created mid-window still gets a valid first slot. */
const MIN_LEAD_MS = 5 * MS_PER_MINUTE;

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
 * Any slot that would land in the past — the campaign was created after its
 * window opened, or with a past `startAt` — is bumped forward to `now +
 * 5min`; later slots are then nudged to stay strictly after the one before,
 * so a bump never reorders the sequence a user was shown.
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

  const slots: Date[] = [];
  for (let day = 0; day < totalDays; day++) {
    const dayWindowStart = dayStart + day * MS_PER_DAY + windowStartHour * MS_PER_HOUR;
    for (let i = 0; i < postsPerDay; i++) {
      // A single post per day sits at the window's midpoint rather than its
      // open, which would otherwise cluster every campaign's first post at
      // exactly the window start hour.
      const offset = postsPerDay === 1 ? windowSpanMs / 2 : (windowSpanMs * i) / (postsPerDay - 1);
      slots.push(new Date(dayWindowStart + offset));
    }
  }

  const earliestAllowed = now.getTime() + MIN_LEAD_MS;
  let previous = -Infinity;
  return slots.map((slot) => {
    const bumped = Math.max(slot.getTime(), earliestAllowed, previous + MS_PER_MINUTE);
    previous = bumped;
    return new Date(bumped);
  });
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
