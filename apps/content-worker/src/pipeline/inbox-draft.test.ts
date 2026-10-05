import type { ContentTaskContext } from '@bmas/db';
import { describe, expect, it } from 'vitest';
import { draftPrompt } from './inbox-draft.js';

const context = {
  identity: {
    brandId: 'b1',
    brandName: 'Bata',
    industry: 'footwear',
    location: 'India',
    audience: null,
    tone: ['friendly'],
    languages: [],
    bannedTopics: ['competitor prices'],
  },
  positioning: null,
  contentPillars: [],
  learnings: [],
  products: [
    {
      id: 'p1',
      name: 'Power Sneaker',
      description: 'White, sizes 6-10',
      sellingPoints: [],
      priceMinor: 149_900,
      currency: 'INR',
    },
    {
      id: 'p2',
      name: 'Comfit Sandal',
      description: null,
      sellingPoints: [],
      priceMinor: null,
      currency: 'INR',
    },
  ],
} as unknown as ContentTaskContext;

describe('draftPrompt', () => {
  it('gives the model the only facts it may state, the post, and who said what', () => {
    const prompt = draftPrompt(context, { channel: 'comment', postCaption: 'New drop 👟' }, [
      { direction: 'in', username: 'priya', text: 'Size 8 milega?' },
      { direction: 'out', username: 'bata', text: 'Haan ji!' },
      { direction: 'in', username: 'priya', text: null },
    ]);

    expect(prompt).toContain('- Power Sneaker, ₹1,499.00 — White, sizes 6-10');
    expect(prompt).toContain('- Comfit Sandal\n'); // no price on file → none stated
    expect(prompt).toContain('Never mention: competitor prices.');
    expect(prompt).toContain('"New drop 👟"');
    expect(prompt).toContain(
      'Customer @priya: Size 8 milega?\nBrand: Haan ji!\nCustomer @priya: [photo or attachment]',
    );
  });
});
