import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { Database } from '@bmas/db';
import type { Queue } from 'bullmq';
import { AdsService } from './ads.service.js';

describe('AdsService', () => {
  it('throws NotFoundException if brand is not owned by user', async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const mockQueue = {
      add: vi.fn(),
    };

    const service = new AdsService(
      mockDb as unknown as Database,
      mockQueue as unknown as Queue,
    );

    await expect(
      service.listCampaigns('brand-1', 'other-user'),
    ).rejects.toThrow(NotFoundException);
  });

  it('calculates aggregated metrics for campaigns correctly', async () => {
    const mockBrand = [{ ownerId: 'user-1' }];
    const mockCampaigns = [
      {
        id: 'c-1',
        brandId: 'brand-1',
        platform: 'google',
        campaignName: 'Google Search',
        status: 'active',
        dailyBudget: 50,
        spendToDate: 500,
        roas: 4.0,
        keywords: ['saree'],
      },
      {
        id: 'c-2',
        brandId: 'brand-1',
        platform: 'meta',
        campaignName: 'Meta Reels',
        status: 'active',
        dailyBudget: 50,
        spendToDate: 500,
        roas: 2.0,
        keywords: ['bridal'],
      },
    ];

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        return Promise.resolve(mockBrand);
      }),
      orderBy: vi.fn().mockReturnValue(Promise.resolve(mockCampaigns)),
    };
    const mockQueue = {
      add: vi.fn(),
    };

    const service = new AdsService(
      mockDb as unknown as Database,
      mockQueue as unknown as Queue,
    );

    const result = await service.listCampaigns('brand-1', 'user-1');

    expect(result.totalSpend).toBe(1000);
    expect(result.totalDailyBudget).toBe(100);
    expect(result.blendedRoas).toBe(3.0);
    expect(result.platformBreakdown.google.count).toBe(1);
    expect(result.platformBreakdown.meta.count).toBe(1);
  });

  it('enqueues ad optimization job when triggered', async () => {
    const mockBrand = [{ ownerId: 'user-1' }];
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockBrand),
    };
    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'job-123' }),
    };

    const service = new AdsService(
      mockDb as unknown as Database,
      mockQueue as unknown as Queue,
    );

    const res = await service.triggerOptimization('brand-1', 'user-1');
    expect(res.status).toBe('queued');
    expect(res.jobId).toBe('job-123');
    expect(mockQueue.add).toHaveBeenCalled();
  });
});
