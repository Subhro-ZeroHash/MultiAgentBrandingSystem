import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, schema, type Database, type ScheduledPost } from '@bmas/db';
import {
  QUEUES,
  computeScheduleSlots,
  type ApproveScheduledPostInput,
  type CreateScheduledCampaignInput,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { AssetUrls } from '../core/asset-urls.js';
import { ASSET_URLS, DATABASE, SCHEDULED_POST_PUBLISH_QUEUE } from '../core/core.module.js';
import { GenerationsService } from '../generations/generations.service.js';

/** Generation starts this long before a post's scheduled time — long enough
 *  for QA/regeneration plus a review window before the publish job fires. If
 *  the slot itself is sooner than this, generation starts immediately. */
const GENERATION_LEAD_MS = 2 * 60 * 60 * 1000;

const PENDING_STATUSES: ScheduledPost['status'][] = [
  'pending_generation',
  'pending_approval',
  'approved',
];

@Injectable()
export class SchedulingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SCHEDULED_POST_PUBLISH_QUEUE) private readonly publishQueue: Queue,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
    private readonly generations: GenerationsService,
  ) {}

  /**
   * Plans a whole campaign in one call: validates the product, computes every
   * slot's publish time, then for each slot inserts a `scheduled_posts` row,
   * queues its generation (delayed so it starts shortly before the slot
   * rather than immediately), and queues its publish job for the exact
   * publish time. The publish job's BullMQ id is the scheduled-post id, so
   * cancelling later can find and remove it directly.
   */
  async createCampaign(brandId: string, input: CreateScheduledCampaignInput) {
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
          brandId,
          productId: input.productId,
          campaignType: input.campaignType,
          styleTemplate: input.styleTemplate,
          outputFormat: input.outputFormat,
          variantCount: 1,
          language: 'en',
        },
        `sched-${campaign.id}-${index}`,
        { delayMs: generationDelayMs },
      );

      const [post] = await this.db
        .insert(schema.scheduledPosts)
        .values({
          campaignId: campaign.id,
          brandId,
          productId: input.productId,
          scheduledFor,
          generationJobId: job.id,
        })
        .returning();
      if (!post) throw new Error('Insert returned no row');

      await this.publishQueue.add(
        QUEUES.scheduledPostPublish,
        { scheduledPostId: post.id },
        {
          // Deterministic id: cancellation looks the job up by scheduled-post
          // id rather than tracking a separate BullMQ job id anywhere.
          jobId: post.id,
          delay: Math.max(0, scheduledFor.getTime() - now.getTime()),
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      );

      posts.push(post);
    }

    return { ...campaign, posts };
  }

  /** Campaign list with a per-status post count, so the UI can render a
   *  progress bar without a second round trip per campaign. */
  async listCampaigns(brandId: string) {
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

    const statusCountsByCampaign = new Map<string, Partial<Record<ScheduledPost['status'], number>>>();
    for (const post of posts) {
      const counts = statusCountsByCampaign.get(post.campaignId) ?? {};
      counts[post.status] = (counts[post.status] ?? 0) + 1;
      statusCountsByCampaign.set(post.campaignId, counts);
    }

    return campaigns.map((campaign) => ({
      ...campaign,
      totalPosts: campaign.totalDays * campaign.postsPerDay,
      statusCounts: statusCountsByCampaign.get(campaign.id) ?? {},
    }));
  }

  async getCampaign(campaignId: string) {
    const [campaign] = await this.db
      .select()
      .from(schema.scheduledCampaigns)
      .where(eq(schema.scheduledCampaigns.id, campaignId))
      .limit(1);
    if (!campaign) throw new NotFoundException(`Scheduled campaign ${campaignId} not found`);

    const posts = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.campaignId, campaignId))
      .orderBy(schema.scheduledPosts.scheduledFor);

    return { ...campaign, posts };
  }

  /** Marks the campaign cancelled, rejects every post that hasn't published
   *  yet, and removes their not-yet-fired publish jobs — a DB-only cancel
   *  would leave those jobs to fire and publish anyway. */
  async cancelCampaign(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);
    const pending = campaign.posts.filter((post) => PENDING_STATUSES.includes(post.status));

    if (pending.length > 0) {
      await this.db
        .update(schema.scheduledPosts)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(
          inArray(
            schema.scheduledPosts.id,
            pending.map((post) => post.id),
          ),
        );

      await Promise.all(
        pending.map(async (post) => {
          const job = await this.publishQueue.getJob(post.id);
          await job?.remove();
        }),
      );
    }

    await this.db
      .update(schema.scheduledCampaigns)
      .set({ status: 'cancelled' })
      .where(eq(schema.scheduledCampaigns.id, campaignId));

    return { success: true, cancelledPosts: pending.length };
  }

  async listPosts(brandId: string, status?: ScheduledPost['status']) {
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

  async getPost(postId: string) {
    const [post] = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.id, postId))
      .limit(1);
    if (!post) throw new NotFoundException(`Scheduled post ${postId} not found`);

    const [asset] = post.selectedAssetId
      ? await this.db
          .select()
          .from(schema.creativeAssets)
          .where(eq(schema.creativeAssets.id, post.selectedAssetId))
          .limit(1)
      : [];

    return { ...post, asset: asset ? (await this.assetUrls.signAll([asset]))[0]! : null };
  }

  async approvePost(postId: string, input: ApproveScheduledPostInput) {
    const [existing] = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.id, postId))
      .limit(1);
    if (!existing) throw new NotFoundException(`Scheduled post ${postId} not found`);
    if (existing.status !== 'pending_approval') {
      throw new BadRequestException(
        `This post is '${existing.status}', not awaiting approval.`,
      );
    }

    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({
        status: 'approved',
        approvedAt: new Date(),
        updatedAt: new Date(),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
      })
      .where(eq(schema.scheduledPosts.id, postId))
      .returning();
    if (!updated) throw new Error('Update returned no row');
    return updated;
  }

  async rejectPost(postId: string) {
    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(schema.scheduledPosts.id, postId))
      .returning();
    if (!updated) throw new NotFoundException(`Scheduled post ${postId} not found`);
    return updated;
  }

  /** Re-runs generation for one slot without disturbing the rest of the
   *  campaign — for when a user rejects a post and wants another attempt
   *  before its publish job fires. Runs immediately (no lead-time delay)
   *  since the user is asking for it right now. */
  async regeneratePost(postId: string) {
    const [post] = await this.db
      .select()
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.id, postId))
      .limit(1);
    if (!post) throw new NotFoundException(`Scheduled post ${postId} not found`);
    if (post.status === 'posted') {
      throw new BadRequestException('This post has already been published.');
    }
    if (post.scheduledFor.getTime() <= Date.now()) {
      throw new BadRequestException('This slot has already passed.');
    }

    const [campaign] = await this.db
      .select()
      .from(schema.scheduledCampaigns)
      .where(eq(schema.scheduledCampaigns.id, post.campaignId))
      .limit(1);
    if (!campaign) throw new NotFoundException(`Scheduled campaign ${post.campaignId} not found`);

    const job = await this.generations.enqueue(
      {
        brandId: post.brandId,
        productId: post.productId,
        campaignType: campaign.campaignType,
        styleTemplate: campaign.styleTemplate,
        outputFormat: campaign.outputFormat,
        variantCount: 1,
        language: 'en',
      },
      `sched-${campaign.id}-retry-${post.id}-${Date.now()}`,
    );

    const [updated] = await this.db
      .update(schema.scheduledPosts)
      .set({
        status: 'pending_generation',
        generationJobId: job.id,
        selectedAssetId: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.scheduledPosts.id, postId))
      .returning();
    if (!updated) throw new Error('Update returned no row');
    return updated;
  }
}
