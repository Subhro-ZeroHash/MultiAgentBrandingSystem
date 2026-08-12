import { describe, expect, it } from 'vitest';
import type { ContentConcept, TrendSuggestedRequest } from '@bmas/shared';
import { buildCreativeRequest } from './opportunity-trigger.js';

/**
 * `buildCreativeRequest` is the join between the Trend Opportunity Engine
 * and the ordinary generation pipeline — a malformed request here would
 * either crash the auto-trigger job or silently generate the wrong thing
 * with no QA step positioned to catch it (it's not a schema-invalid image,
 * just the wrong copy/format).
 */

const suggestedRequest: TrendSuggestedRequest = {
  campaignType: 'offer',
  styleTemplate: 'bold_discount',
  outputFormat: 'instagram_post',
  headlineText: null,
  offerText: null,
  extraInstructions: null,
};

const concept: ContentConcept = {
  label: '30-Day Running Challenge Kickoff',
  postConcept: 'Announce a 30-day running challenge tied to the festival.',
  captionText: 'Join our 30-day running challenge starting this weekend!',
  hashtags: ['RunningChallenge', 'FitIndia'],
  ctaText: 'Join Now',
  visualDirection: 'Dynamic runner mid-stride at sunrise, bold typography overlay.',
  outputFormat: 'story_reel_cover',
};

describe('buildCreativeRequest', () => {
  it('uses the concept, not the opportunity, for outputFormat and headline', () => {
    const request = buildCreativeRequest({ suggestedRequest }, 'brand-1', 'product-1', concept);
    expect(request.outputFormat).toBe('story_reel_cover');
    expect(request.headlineText).toBe(concept.label);
  });

  it('carries campaignType and styleTemplate straight from the opportunity', () => {
    const request = buildCreativeRequest({ suggestedRequest }, 'brand-1', 'product-1', concept);
    expect(request.campaignType).toBe('offer');
    expect(request.styleTemplate).toBe('bold_discount');
  });

  it("falls back to the concept's CTA when the opportunity has no offer text", () => {
    const request = buildCreativeRequest({ suggestedRequest }, 'brand-1', 'product-1', concept);
    expect(request.offerText).toBe('Join Now');
  });

  it("prefers the opportunity's own offer text when it has one", () => {
    const request = buildCreativeRequest(
      { suggestedRequest: { ...suggestedRequest, offerText: '20% off this weekend' } },
      'brand-1',
      'product-1',
      concept,
    );
    expect(request.offerText).toBe('20% off this weekend');
  });

  it('folds the concept into extraInstructions, within the 500-char cap composeBrief expects', () => {
    const request = buildCreativeRequest({ suggestedRequest }, 'brand-1', 'product-1', concept);
    expect(request.extraInstructions).toContain(concept.postConcept);
    expect(request.extraInstructions).toContain(concept.visualDirection);
    expect(request.extraInstructions).toContain('#RunningChallenge');
    expect(request.extraInstructions).toContain(concept.captionText);
    expect(request.extraInstructions!.length).toBeLessThanOrEqual(500);
  });

  it('always requests a single uniform variant, never a fan-out', () => {
    const request = buildCreativeRequest({ suggestedRequest }, 'brand-1', 'product-1', concept);
    expect(request.variantMode).toBe('uniform');
    expect(request.variantCount).toBe(1);
  });

  it('rejects a concept whose hashtags/caption push extraInstructions past the schema cap', () => {
    const longConcept: ContentConcept = {
      ...concept,
      postConcept: 'x'.repeat(400),
      visualDirection: 'y'.repeat(400),
    };
    // creativeRequestSchema.parse() inside buildCreativeRequest truncates to
    // 500 chars rather than throwing — pinning that it never exceeds the cap
    // regardless of how verbose the model's concept output is.
    const request = buildCreativeRequest({ suggestedRequest }, 'brand-1', 'product-1', longConcept);
    expect(request.extraInstructions!.length).toBeLessThanOrEqual(500);
  });
});
