import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, schema, type Database, type ScheduledPost } from '@bmas/db';
import {
  QUEUES,
  computeScheduleSlots,
  type ApproveScheduledPostInput,
  type CreateScheduledCampaignInput,
  type ScheduledPostStatusFilter,
  type UpdateScheduledCampaignInput,
  type UpdateScheduledPostInput,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { AssetUrls } from '../core/asset-urls.js';
import {
  ASSET_URLS,
  DATABASE,
  GENERATION_QUEUE,
  SCHEDULED_POST_PUBLISH_QUEUE,
} from '../core/core.module.js';
import { GenerationsService } from '../generations/generations.service.js';

/** Generation starts this long before a post's scheduled time — long enough
 *  for QA/regeneration plus a review window before the publish job fires. If
 *  the slot itself is sooner than this, generation starts immediately. */
const GENERATION_LEAD_MS = 2 * 60 * 60 * 1000;

/** Posts a cancel or pause still has a say over: nothing has been sent to
 *  Instagram for these, so their queue jobs can be pulled. */
const PENDING_STATUSES: ScheduledPost['status'][] = [
  'pending_generation',
  'pending_approval',
  'approved',
];

/** Posts an edit may re-plan. Deliberately narrower than PENDING_STATUSES:
 *  once a post has been generated the user has (or soon will have) reviewed
 *  it, and silently deleting reviewed work to honour a cadence change would
 *  lose something they cannot get back. */
const REPLANNABLE_STATUSES: ScheduledPost['status'][] = ['pending_generation'];

@Injectable()
export class SchedulingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SCHEDULED_POST_PUBLISH_QUEUE) private readonly publishQueue: Queue,
    @Inject(GENERATION_QUEUE) private readonly generationQueue: Queue,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
    private readonly generations: GenerationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Ownership
  //
  // Auth is unbuilt (see CLAUDE.md), but `SocialService` already scopes every
  // account read by `ownerId`, so leaving these routes addressable by id alone
  // was an inconsistency rather than a shared gap: anyone who guessed a UUID
  // could approve or cancel someone else's campaign. These resolve the owner
  // through the brand and refuse anything that is not theirs.
  // ---------------------------------------------------------------------------

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) {
      throw new ForbiddenException('This brand belongs to another account.');
    }
  }

  private async loadOwnedCampaign(campaignId: string, ownerId: string) {
    const [campaign] = await this.db
      .select()
      .from(schema.scheduledCampaigns)
      .where(eq(schema.scheduledCampaigns.id, campaignId))
      .limit(1);
    if (!campaign) throw new NotFoundException(`Scheduled campaign ${campaignId} not found`);
    await this.assertBrandOwned(campaign.brandId, ownerId);
    return campaign;
  }

  private async loadOwnedPost(postId: string, ownerId: string) {
    const [post] = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.id, postId))
      .limit(1);
    if (!post) throw new NotFoundException(`Scheduled post ${postId} not found`);
    await this.assertBrandOwned(post.brandId, ownerId);
    return post;
  }

  // ---------------------------------------------------------------------------
  // Queue plumbing
  // ---------------------------------------------------------------------------

  /** The publish job for a post is keyed by the post id, so it can be pulled
   *  without tracking a BullMQ id anywhere. */
  private async removePublishJob(postId: string): Promise<void> {
    const job = await this.publishQueue.getJob(postId);
    await job?.remove().catch(() => undefined);
  }

  /**
   * Pulls the queued generation for a post, if it has not started yet.
   *
   * The BullMQ job id is the generation's idempotency key, which lives on the
   * `generation_jobs` row rather than being reconstructible from the campaign —
   * regeneration mints a new one — so it is read back rather than guessed.
   */
  private async removeGenerationJob(generationJobId: string | null): Promise<void> {
    if (!generationJobId) return;
    const [job] = await this.db
      .select({ idempotencyKey: schema.generationJobs.idempotencyKey })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, generationJobId))
      .limit(1);
    if (!job) return;

    const queued = await this.generationQueue.getJob(job.idempotencyKey);
    await queued?.remove().catch(() => undefined);
  }

  private async enqueuePublish(postId: string, scheduledFor: Date, now: Date): Promise<void> {
    await this.publishQueue.add(
      QUEUES.scheduledPostPublish,
      { scheduledPostId: postId },
      {
        // Deterministic id: cancellation looks the job up by scheduled-post
        // id rather than tracking a separate BullMQ job id anywhere.
        jobId: postId,
        delay: Math.max(0, scheduledFor.getTime() - now.getTime()),
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /**
   * Plans a whole campaign in one call: validates the product, computes every
   * slot's publish time, then for each slot inserts a `scheduled_posts` row,
   * queues its generation (delayed so it starts shortly before the slot rather
   * than immediately), and queues its publish job for the exact publish time.
   *
   * The whole thing either lands or is undone. Queue work cannot join a
   * database transaction, so failure is handled by compensation instead: every
   * job added and row written is tracked, and a throw at slot 9 of 15 tears the
   * first 8 back down. Without that, a client that saw a 500 and assumed
   * nothing happened would still have had eight posts publish to their
   * Instagram on schedule.
   */
  async createCampaign(brandId: string, ownerId: string, input: CreateScheduledCampaignInput) {
    await this.assertBrandOwned(brandId, ownerId);

    const [product] = await this.db
      .select({ brandId: schema.products.brandId })
      .from(schema.products)
      .where(eq(schema.products.id, input.productId))
      .limit(1);
    if (!product) throw new NotFoundException(`Product ${input.productId} not found`);
    if (product.brandId !== brandId) {
      throw new BadRequestException(
        `Product ${input.productId} does not belong to brand ${brandId}`,
      );
    }

    const now = new Date();
    const startAt = input.startAt ?? now;
    const slots = computeScheduleSlots({
      startAt,
      totalDays: input.totalDays,
      postsPerDay: input.postsPerDay,
      now,
    });
    if (slots.length === 0) {
      throw new BadRequestException(
        'That schedule has no slots left far enough ahead to generate and review. Pick a later start date.',
      );
    }

    const [campaign] = await this.db
      .insert(schema.scheduledCampaigns)
      .values({
        brandId,
        productId: input.productId,
        campaignType: input.campaignType,
        styleTemplate: input.styleTemplate,
        outputFormat: input.outputFormat,
        totalDays: input.totalDays,
        postsPerDay: input.postsPerDay,
        startAt,
      })
      .returning();
    if (!campaign) throw new Error('Insert returned no row');

    try {
      const posts = await this.planSlots(campaign, slots, now, 0, ownerId);
      return { ...campaign, posts };
    } catch (error) {
      await this.tearDownCampaign(campaign.id);
      throw error;
    }
  }

  /**
   * Materialises `slots` into posts with their generation and publish jobs.
   * Shared by creation and by re-planning after an edit; `keyOffset` keeps
   * generation idempotency keys unique across successive edits of the same
   * campaign, since a reused key would silently return the earlier job.
   */
  private async planSlots(
    campaign: typeof schema.scheduledCampaigns.$inferSelect,
    slots: Date[],
    now: Date,
    keyOffset: number,
    ownerId: string,
  ): Promise<ScheduledPost[]> {
    const posts: ScheduledPost[] = [];

    for (const [index, scheduledFor] of slots.entries()) {
      const generationDelayMs = Math.max(
        0,
        scheduledFor.getTime() - GENERATION_LEAD_MS - now.getTime(),
      );

      // One generation call per slot, low variant count by default — a
      // 3-day x 5/day campaign is already 15 generations at 1 variant each.
      const job = await this.generations.enqueue(
        {
          brandId: campaign.brandId,
          productId: campaign.productId,
          campaignType: campaign.campaignType,
          styleTemplate: campaign.styleTemplate,
          outputFormat: campaign.outputFormat,
          variantCount: 1,
          // Explicit, not just the schema default: scheduled/auto-campaigns
          // keep today's single shared-prompt behaviour on purpose — the
          // 'diverse' mode (three brief per image) is the manual Create
          // screen's cost/quantity tradeoff, not this one's.
          variantMode: 'uniform',
          language: 'en',
        },
        `sched-${campaign.id}-${keyOffset + index}`,
        ownerId,
        { delayMs: generationDelayMs },
      );

      const [post] = await this.db
        .insert(schema.scheduledPosts)
        .values({
          campaignId: campaign.id,
          brandId: campaign.brandId,
          productId: campaign.productId,
          scheduledFor,
          generationJobId: job.id,
        })
        .returning();
      if (!post) throw new Error('Insert returned no row');

      await this.enqueuePublish(post.id, scheduledFor, now);
      posts.push(post);
    }

    return posts;
  }

  /** Compensation for a half-built campaign: pull every queue job its posts
   *  own, then delete the campaign (posts cascade). Best-effort throughout —
   *  it runs while another error is already propagating, so a failure here must
   *  not mask the original one. */
  private async tearDownCampaign(campaignId: string): Promise<void> {
    try {
      const posts = await this.db
        .select()
        .from(schema.scheduledPosts)
        .where(eq(schema.scheduledPosts.campaignId, campaignId));

      await Promise.all(
        posts.map(async (post) => {
          await this.removePublishJob(post.id);
          await this.removeGenerationJob(post.generationJobId);
        }),
      );

      await this.db
        .delete(schema.scheduledCampaigns)
        .where(eq(schema.scheduledCampaigns.id, campaignId));
    } catch (cleanupError) {
      console.error(
        `[scheduling] failed to clean up partially created campaign ${campaignId}:`,
        cleanupError,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Campaign list with a per-status post count, so the UI can render a
   *  progress bar without a second round trip per campaign. */
  async listCampaigns(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);

    const campaigns = await this.db
      .select()
      .from(schema.scheduledCampaigns)
      .where(eq(schema.scheduledCampaigns.brandId, brandId))
      .orderBy(desc(schema.scheduledCampaigns.createdAt));

    if (campaigns.length === 0) return [];

    const posts = await this.db
      .select({
        campaignId: schema.scheduledPosts.campaignId,
        status: schema.scheduledPosts.status,
      })
      .from(schema.scheduledPosts)
      .where(
        inArray(
          schema.scheduledPosts.campaignId,
          campaigns.map((campaign) => campaign.id),
        ),
      );

    const statusCountsByCampaign = new Map<
      string,
      Partial<Record<ScheduledPost['status'], number>>
    >();
    const totalByCampaign = new Map<string, number>();
    for (const post of posts) {
      const counts = statusCountsByCampaign.get(post.campaignId) ?? {};
      counts[post.status] = (counts[post.status] ?? 0) + 1;
      statusCountsByCampaign.set(post.campaignId, counts);
      totalByCampaign.set(post.campaignId, (totalByCampaign.get(post.campaignId) ?? 0) + 1);
    }

    return campaigns.map((campaign) => ({
      ...campaign,
      // The real row count, not totalDays x postsPerDay: an edit re-plans only
      // part of a campaign, so the arithmetic no longer describes it.
      totalPosts: totalByCampaign.get(campaign.id) ?? 0,
      statusCounts: statusCountsByCampaign.get(campaign.id) ?? {},
    }));
  }

  async getCampaign(campaignId: string, ownerId: string) {
    const campaign = await this.loadOwnedCampaign(campaignId, ownerId);

    const posts = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.campaignId, campaignId))
      .orderBy(schema.scheduledPosts.scheduledFor);

    return { ...campaign, posts };
  }

  async listPosts(brandId: string, ownerId: string, status?: ScheduledPostStatusFilter) {
    await this.assertBrandOwned(brandId, ownerId);

    return this.db
      .select()
      .from(schema.scheduledPosts)
      .where(
        status
          ? and(eq(schema.scheduledPosts.brandId, brandId), eq(schema.scheduledPosts.status, status))
          : eq(schema.scheduledPosts.brandId, brandId),
      )
      .orderBy(schema.scheduledPosts.scheduledFor);
  }

  async getPost(postId: string, ownerId: string) {
    const post = await this.loadOwnedPost(postId, ownerId);

    const [asset] = post.selectedAssetId
      ? await this.db
          .select()
          .from(schema.creativeAssets)
          .where(eq(schema.creativeAssets.id, post.selectedAssetId))
          .limit(1)
      : [];

    return { ...post, asset: asset ? (await this.assetUrls.signAll([asset]))[0]! : null };
  }

  // ---------------------------------------------------------------------------
  // Campaign lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Edits a running campaign.
   *
   * Creative changes (type/style/format) apply to work not yet generated —
   * anything already rendered keeps the look it was reviewed under. A cadence
   * change re-plans only the `pending_generation` tail: those posts are torn
   * down and replaced with a fresh schedule for however many the new cadence
   * still calls for, while generated, approved and published posts keep their
   * slots untouched.
   */
  async updateCampaign(campaignId: string, ownerId: string, input: UpdateScheduledCampaignInput) {
    const campaign = await this.loadOwnedCampaign(campaignId, ownerId);
    if (campaign.status === 'cancelled' || campaign.status === 'completed') {
      throw new BadRequestException(`A ${campaign.status} campaign cannot be edited.`);
    }

    const [updatedCampaign] = await this.db
      .update(schema.scheduledCampaigns)
      .set({
        ...(input.campaignType ? { campaignType: input.campaignType } : {}),
        ...(input.styleTemplate ? { styleTemplate: input.styleTemplate } : {}),
        ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
        ...(input.totalDays ? { totalDays: input.totalDays } : {}),
        ...(input.postsPerDay ? { postsPerDay: input.postsPerDay } : {}),
      })
      .where(eq(schema.scheduledCampaigns.id, campaignId))
      .returning();
    if (!updatedCampaign) throw new Error('Update returned no row');

    const existing = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.campaignId, campaignId));

    const replannable = existing.filter((post) => REPLANNABLE_STATUSES.includes(post.status));
    const committed = existing.length - replannable.length;

    // Nothing to re-plan: a creative-only edit, or every post is already made.
    const cadenceChanged = input.totalDays !== undefined || input.postsPerDay !== undefined;
    if (!cadenceChanged && replannable.length === 0) {
      return this.getCampaign(campaignId, ownerId);
    }

    for (const post of replannable) {
      await this.removePublishJob(post.id);
      await this.removeGenerationJob(post.generationJobId);
    }
    if (replannable.length > 0) {
      await this.db.delete(schema.scheduledPosts).where(
        inArray(
          schema.scheduledPosts.id,
          replannable.map((post) => post.id),
        ),
      );
    }

    const now = new Date();
    const wanted = Math.max(0, updatedCampaign.totalDays * updatedCampaign.postsPerDay - committed);
    if (wanted > 0) {
      const slots = computeScheduleSlots({
        // Re-planned from now, not the original start: the days already spent
        // cannot be filled retroactively.
        startAt: now,
        totalDays: updatedCampaign.totalDays,
        postsPerDay: updatedCampaign.postsPerDay,
        now,
      }).slice(0, wanted);

      // Keys continue past every slot this campaign has ever planned, so an
      // edit cannot collide with a retired generation's idempotency key.
      await this.planSlots(updatedCampaign, slots, now, Date.now(), ownerId);
    }

    return this.getCampaign(campaignId, ownerId);
  }

  /** Holds a campaign without discarding it: queued work is pulled, rows stay.
   *  Posts keep their status so resuming knows what still needs doing. */
  async pauseCampaign(campaignId: string, ownerId: string) {
    const campaign = await this.loadOwnedCampaign(campaignId, ownerId);
    if (campaign.status !== 'active') {
      throw new BadRequestException(`Only an active campaign can be paused (this one is ${campaign.status}).`);
    }

    const posts = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.campaignId, campaignId));

    for (const post of posts.filter((candidate) => PENDING_STATUSES.includes(candidate.status))) {
      await this.removePublishJob(post.id);
      await this.removeGenerationJob(post.generationJobId);
    }

    await this.db
      .update(schema.scheduledCampaigns)
      .set({ status: 'paused' })
      .where(eq(schema.scheduledCampaigns.id, campaignId));

    return this.getCampaign(campaignId, ownerId);
  }

  /**
   * Restarts a paused campaign.
   *
   * Slots that came and went during the pause cannot be recovered, so they are
   * marked expired rather than fired late; everything still in the future gets
   * its generation and publish jobs put back.
   */
  async resumeCampaign(campaignId: string, ownerId: string) {
    const campaign = await this.loadOwnedCampaign(campaignId, ownerId);
    if (campaign.status !== 'paused') {
      throw new BadRequestException(`Only a paused campaign can be resumed (this one is ${campaign.status}).`);
    }

    const now = new Date();
    const posts = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.campaignId, campaignId));

    const pending = posts.filter((post) => PENDING_STATUSES.includes(post.status));
    const missed = pending.filter((post) => post.scheduledFor.getTime() <= now.getTime());
    const revivable = pending.filter((post) => post.scheduledFor.getTime() > now.getTime());

    if (missed.length > 0) {
      await this.db
        .update(schema.scheduledPosts)
        .set({ status: 'expired', updatedAt: now })
        .where(
          inArray(
            schema.scheduledPosts.id,
            missed.map((post) => post.id),
          ),
        );
    }

    for (const post of revivable) {
      if (post.status === 'pending_generation') {
        // A fresh key: the paused job was removed from the queue, and reusing
        // its key would hand back the same dead generation row.
        const job = await this.generations.enqueue(
          {
            brandId: campaign.brandId,
            productId: campaign.productId,
            campaignType: campaign.campaignType,
            styleTemplate: campaign.styleTemplate,
            outputFormat: campaign.outputFormat,
            variantCount: 1,
            variantMode: 'uniform',
            language: 'en',
          },
          `sched-${campaign.id}-resume-${post.id}-${now.getTime()}`,
          ownerId,
          {
            delayMs: Math.max(
              0,
              post.scheduledFor.getTime() - GENERATION_LEAD_MS - now.getTime(),
            ),
          },
        );

        await this.db
          .update(schema.scheduledPosts)
          .set({ generationJobId: job.id, updatedAt: now })
          .where(eq(schema.scheduledPosts.id, post.id));
      }

      await this.enqueuePublish(post.id, post.scheduledFor, now);
    }

    await this.db
      .update(schema.scheduledCampaigns)
      .set({ status: 'active' })
      .where(eq(schema.scheduledCampaigns.id, campaignId));

    return this.getCampaign(campaignId, ownerId);
  }

  /** Marks the campaign cancelled, rejects every post that hasn't published
   *  yet, and removes their queue jobs — a DB-only cancel would leave the
   *  publish jobs to fire anyway, and the generation jobs to keep spending on
   *  a campaign nobody wants. */
  async cancelCampaign(campaignId: string, ownerId: string) {
    const campaign = await this.getCampaign(campaignId, ownerId);
    const pendingIds = campaign.posts
      .filter((post) => PENDING_STATUSES.includes(post.status))
      .map((post) => post.id);

    let cancelled: ScheduledPost[] = [];
    if (pendingIds.length > 0) {
      // Rows first: a publish job firing in the gap then sees a rejected post
      // and declines to publish, whereas the reverse order leaves a window
      // where the job is still armed against an approved row.
      //
      // Conditional on status, not just id — the same guard approvePost/
      // rejectPost use so two status changes racing cannot both proceed. A
      // post that the publish worker claimed (-> 'publishing') between the
      // snapshot above and this UPDATE must be left alone: without this guard
      // an unconditional UPDATE would overwrite it back to 'rejected' while it
      // is actually mid-publish, and the worker's own unconditional final
      // write would then silently overwrite that back to 'posted' — leaving
      // cancelCampaign's response claiming a post was cancelled that actually
      // published.
      cancelled = await this.db
        .update(schema.scheduledPosts)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(
          and(
            inArray(schema.scheduledPosts.id, pendingIds),
            inArray(schema.scheduledPosts.status, PENDING_STATUSES),
          ),
        )
        .returning();

      await Promise.all(
        cancelled.map(async (post) => {
          await this.removePublishJob(post.id);
          // Generation too. Left queued, it would run for a cancelled campaign,
          // spend a provider call, and then find its post already rejected.
          await this.removeGenerationJob(post.generationJobId);
        }),
      );
    }

    await this.db
      .update(schema.scheduledCampaigns)
      .set({ status: 'cancelled' })
      .where(eq(schema.scheduledCampaigns.id, campaignId));

    return { success: true, cancelledPosts: cancelled.length };
  }

  // ---------------------------------------------------------------------------
  // Post lifecycle
  // ---------------------------------------------------------------------------

  async approvePost(postId: string, ownerId: string, input: ApproveScheduledPostInput) {
    const existing = await this.loadOwnedPost(postId, ownerId);
    if (existing.status !== 'pending_approval') {
      throw new BadRequestException(`This post is '${existing.status}', not awaiting approval.`);
    }

    // An account id arrives straight from the client, so it is checked against
    // the caller rather than trusted. Publishing would reject a foreign account
    // anyway, but only hours later and as a failed post.
    if (input.accountId) await this.assertAccountOwned(input.accountId, ownerId);

    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({
        status: 'approved',
        approvedAt: new Date(),
        updatedAt: new Date(),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
      })
      // Conditional on the status we just read, so two approvals racing cannot
      // both proceed.
      .where(
        and(
          eq(schema.scheduledPosts.id, postId),
          eq(schema.scheduledPosts.status, 'pending_approval'),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('This post is no longer awaiting approval.');
    return updated;
  }

  private async assertAccountOwned(accountId: string, ownerId: string): Promise<void> {
    const [account] = await this.db
      .select({ ownerId: schema.socialAccounts.ownerId })
      .from(schema.socialAccounts)
      .where(eq(schema.socialAccounts.id, accountId))
      .limit(1);
    if (!account) throw new NotFoundException(`Social account ${accountId} not found`);
    if (account.ownerId !== ownerId) {
      throw new ForbiddenException('That social account belongs to another user.');
    }
  }

  /** Rejecting is only meaningful while a post can still publish. Without this
   *  guard a published post could be flipped to 'rejected', leaving the record
   *  claiming it never went out while it sits live on Instagram. */
  async rejectPost(postId: string, ownerId: string) {
    const existing = await this.loadOwnedPost(postId, ownerId);
    if (!PENDING_STATUSES.includes(existing.status)) {
      throw new BadRequestException(
        `This post is '${existing.status}' and can no longer be rejected.`,
      );
    }

    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(
        and(
          eq(schema.scheduledPosts.id, postId),
          inArray(schema.scheduledPosts.status, PENDING_STATUSES),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('This post can no longer be rejected.');

    // It will not publish now, so its job is dead weight — and leaving it armed
    // means a later status change could let it fire.
    await this.removePublishJob(postId);
    return updated;
  }

  /** Edits a planned post in place without approving it: retime the slot, or
   *  fix the copy and destination and leave it awaiting review. */
  async updatePost(postId: string, ownerId: string, input: UpdateScheduledPostInput) {
    const existing = await this.loadOwnedPost(postId, ownerId);
    if (!PENDING_STATUSES.includes(existing.status)) {
      throw new BadRequestException(`A '${existing.status}' post can no longer be edited.`);
    }
    if (input.accountId) await this.assertAccountOwned(input.accountId, ownerId);

    const now = new Date();
    if (input.scheduledFor && input.scheduledFor.getTime() <= now.getTime()) {
      throw new BadRequestException('Pick a time in the future.');
    }

    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({
        updatedAt: now,
        ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
      })
      .where(eq(schema.scheduledPosts.id, postId))
      .returning();
    if (!updated) throw new Error('Update returned no row');

    // Retiming means the armed job would fire at the old moment, so it is
    // replaced rather than left in place.
    if (input.scheduledFor) {
      await this.removePublishJob(postId);
      await this.enqueuePublish(postId, input.scheduledFor, now);
    }

    return updated;
  }

  /** Re-runs generation for one slot without disturbing the rest of the
   *  campaign — for when a user rejects a post and wants another attempt
   *  before its publish job fires. Runs immediately (no lead-time delay)
   *  since the user is asking for it right now. */
  async regeneratePost(postId: string, ownerId: string) {
    const post = await this.loadOwnedPost(postId, ownerId);
    if (post.status === 'posted' || post.status === 'publishing') {
      throw new BadRequestException('This post has already been published.');
    }
    if (post.scheduledFor.getTime() <= Date.now()) {
      throw new BadRequestException('This slot has already passed.');
    }

    const campaign = await this.loadOwnedCampaign(post.campaignId, ownerId);

    // The retired generation would otherwise keep running and, on finishing,
    // find a post whose job id no longer points at it.
    await this.removeGenerationJob(post.generationJobId);

    const job = await this.generations.enqueue(
      {
        brandId: post.brandId,
        productId: post.productId,
        campaignType: campaign.campaignType,
        styleTemplate: campaign.styleTemplate,
        outputFormat: campaign.outputFormat,
        variantCount: 1,
        variantMode: 'uniform',
        language: 'en',
      },
      `sched-${campaign.id}-retry-${post.id}-${Date.now()}`,
      ownerId,
    );

    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({
        status: 'pending_generation',
        generationJobId: job.id,
        selectedAssetId: null,
        approvedAt: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.scheduledPosts.id, postId))
      .returning();
    if (!updated) throw new Error('Update returned no row');

    // A rejected post's publish job was pulled; regenerating means it should
    // fire again at its original slot.
    await this.removePublishJob(postId);
    await this.enqueuePublish(postId, post.scheduledFor, new Date());

    return updated;
  }
}
