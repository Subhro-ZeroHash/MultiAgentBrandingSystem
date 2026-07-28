import { beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Brand } from '@bmas/db';
import type { CreativeRequest } from '@bmas/shared';
import { regenerateFailures, type Brief, type CheckedVariant, type StageContext } from './stages.js';

/**
 * Auto-regeneration is the one stage that can double a job's provider spend, so
 * these tests are as much about what it *declines* to do as what it does. Every
 * case asserts the number of image calls, because that number is the cost.
 */

/** A real encoded image, so the thumbnail path runs for the same reason it does
 *  in production rather than silently failing into its fallback. */
let pixels: Buffer;
beforeAll(async () => {
  pixels = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#7C2D12' },
  })
    .jpeg()
    .toBuffer();
});

const brief: Brief = {
  prompt: 'a prompt',
  requiredText: ['DesiWanderer'],
  width: 1080,
  height: 1080,
};

function variant(overrides: Partial<CheckedVariant> = {}): CheckedVariant {
  return {
    storageKey: 'brands/b/generations/j/variant-1.jpg',
    thumbnailStorageKey: 'brands/b/generations/j/variant-1-thumb.jpg',
    width: 1080,
    height: 1080,
    provider: 'google',
    model: 'gemini-3-pro-image',
    passed: true,
    detectedText: 'DesiWanderer',
    checked: true,
    ...overrides,
  };
}

interface Harness {
  ctx: StageContext;
  /** How many images the provider was asked for, per call. The sum is the spend. */
  imageCalls: number[];
}

function harness(options: { readback: string | (() => string); generate?: () => never }): Harness {
  const imageCalls: number[] = [];

  const generate = vi.fn(async ({ count }: { count: number }) => {
    imageCalls.push(count);
    if (options.generate) options.generate();
    return {
      value: Array.from({ length: count }, () => ({
        data: pixels,
        mediaType: 'image/jpeg' as const,
        width: 1080,
        height: 1080,
        model: 'gemini-3-pro-image',
      })),
      cost: { provider: 'google', model: 'gemini-3-pro-image', operation: 'image', costMicroUsd: 1 },
    };
  });

  const analyzeImage = vi.fn(async () => ({
    value: typeof options.readback === 'string' ? options.readback : options.readback(),
    cost: { provider: 'google', model: 'qa', operation: 'vision', costMicroUsd: 1 },
  }));

  // Only the two chains the stage uses: product-image reads and cost inserts.
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  };

  const ctx = {
    ai: {
      imageGenerator: () => ({ provider: 'google', generate }),
      llm: () => ({ analyzeImage }),
    },
    brand: { id: 'brand-1', name: 'DesiWanderer', colors: [] } as unknown as Brand,
    request: { productId: 'p1', variantCount: 2 } as unknown as CreativeRequest,
    db,
    storage: { get: async () => pixels, put: async () => undefined },
    jobId: 'job-1',
  } as unknown as StageContext;

  return { ctx, imageCalls };
}

describe('regenerateFailures — cost ceiling', () => {
  it('spends nothing when every variant passed', async () => {
    const { ctx, imageCalls } = harness({ readback: 'DesiWanderer' });
    const input = [variant(), variant()];

    const result = await regenerateFailures(ctx, brief, input, 1);

    expect(imageCalls).toEqual([]);
    expect(result).toEqual(input);
  });

  it('spends nothing when rounds is 0, however many failed', async () => {
    const { ctx, imageCalls } = harness({ readback: 'DesiWanderer' });
    const input = [variant({ passed: false }), variant({ passed: false })];

    const result = await regenerateFailures(ctx, brief, input, 0);

    expect(imageCalls).toEqual([]);
    expect(result).toEqual(input);
  });

  it('does not retry a variant QA could not check', async () => {
    // `checked: false` means the readback itself failed — a QA outage, not
    // evidence of a bad image. Retrying would spend money to learn nothing.
    const { ctx, imageCalls } = harness({ readback: 'DesiWanderer' });
    const input = [variant({ checked: false, passed: true, notes: 'qa readback unavailable' })];

    const result = await regenerateFailures(ctx, brief, input, 1);

    expect(imageCalls).toEqual([]);
    expect(result).toEqual(input);
  });

  it('asks only for the variants that failed, not the whole batch', async () => {
    const { ctx, imageCalls } = harness({ readback: 'DesiWanderer' });
    const input = [variant(), variant({ passed: false }), variant()];

    await regenerateFailures(ctx, brief, input, 1);

    expect(imageCalls).toEqual([1]);
  });

  it('stops after the configured number of rounds', async () => {
    // Readback never matches, so every round fails and the cap is what ends it.
    const { ctx, imageCalls } = harness({ readback: 'NONE' });
    const input = [variant({ passed: false })];

    await regenerateFailures(ctx, brief, input, 2);

    expect(imageCalls).toEqual([1, 1]);
  });

  it('bounds worst-case spend at variantCount x (1 + rounds)', async () => {
    const { ctx, imageCalls } = harness({ readback: 'NONE' });
    const variantCount = 3;
    const rounds = 1;
    const input = Array.from({ length: variantCount }, () => variant({ passed: false }));

    await regenerateFailures(ctx, brief, input, rounds);

    const regenerated = imageCalls.reduce((sum, n) => sum + n, 0);
    expect(regenerated + variantCount).toBeLessThanOrEqual(variantCount * (1 + rounds));
  });
});

describe('regenerateFailures — choosing the best result', () => {
  it('replaces a failed variant when the retry passes', async () => {
    const { ctx } = harness({ readback: 'DesiWanderer' });
    const failed = variant({ passed: false, notes: 'missing or misspelled: DesiWanderer' });

    const [result] = await regenerateFailures(ctx, brief, [failed], 1);

    expect(result!.passed).toBe(true);
    expect(result!.storageKey).not.toBe(failed.storageKey);
    expect(result!.notes).toMatch(/regenerated after failed readback/);
  });

  it('keeps the original when the retry fails too', async () => {
    // Swapping one failure for another spends money to change nothing, and the
    // original is at least what the customer's brief produced.
    const { ctx } = harness({ readback: 'NONE' });
    const failed = variant({ passed: false });

    const [result] = await regenerateFailures(ctx, brief, [failed], 1);

    expect(result).toEqual(failed);
  });

  it('leaves passing variants untouched at their original index', async () => {
    const { ctx } = harness({ readback: 'DesiWanderer' });
    const good = variant({ storageKey: 'good.jpg' });
    const bad = variant({ storageKey: 'bad.jpg', passed: false });

    const result = await regenerateFailures(ctx, brief, [good, bad, good], 1);

    expect(result[0]).toEqual(good);
    expect(result[2]).toEqual(good);
    expect(result[1]!.storageKey).not.toBe('bad.jpg');
  });

  it('gives the replacement its own thumbnail', async () => {
    const { ctx } = harness({ readback: 'DesiWanderer' });

    const [result] = await regenerateFailures(ctx, brief, [variant({ passed: false })], 1);

    expect(result!.thumbnailStorageKey).toMatch(/-thumb\.jpg$/);
    expect(result!.thumbnailStorageKey).toContain('-r1');
  });

  it('keeps the originals when regeneration throws, rather than failing the job', async () => {
    // The originals are intact and already paid for; they ship rather than the
    // customer getting nothing.
    const { ctx } = harness({
      readback: 'DesiWanderer',
      generate: () => {
        throw new Error('provider exploded');
      },
    });
    const input = [variant({ passed: false })];

    await expect(regenerateFailures(ctx, brief, input, 1)).resolves.toEqual(input);
  });
});
