import { describe, expect, it } from 'vitest';
import type { Brand } from '@bmas/db';
import type { CopyPack, CreativeRequest } from '@bmas/shared';
import { composeBrief, type StageContext } from './stages.js';

/**
 * `composeBrief` turns the Brand Kit, the product row and the generated copy
 * into the single prompt the image model sees, plus the `requiredText` list QA
 * later reads back off the pixels. Both halves are worth pinning: a regression
 * here is invisible until someone looks at a finished advertisement.
 *
 * The stage resolves its own reads, so the tests drive it through a fake `db`
 * rather than a live Postgres — these stay unit tests.
 */

interface FakeRows {
  product?:
    | { name: string; description: string | null; sellingPoints?: string[] }
    | undefined;
  /** Whether the product has at least one reference photo on file. */
  hasImage?: boolean;
}

/**
 * Minimal stand-in for the Drizzle query builder, covering only the two chains
 * `composeBrief` uses: `select().from().where().limit()`. It answers by call
 * order — products first, product_images second — which is what the stage does.
 */
function fakeDb(rows: FakeRows) {
  let call = 0;
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => {
      call += 1;
      if (call === 1) {
        if (!rows.product) return Promise.resolve([]);
        // Real rows always carry `sellingPoints` (jsonb, defaulted at the DB);
        // defaulting it here too so tests that don't care about it don't have
        // to restate it on every fixture.
        return Promise.resolve([{ sellingPoints: [], ...rows.product }]);
      }
      return Promise.resolve(rows.hasImage ? [{ id: 'image-1' }] : []);
    },
  };
  return { select: () => builder } as unknown as StageContext['db'];
}

const brand = {
  name: 'DesiWanderer',
  colors: ['#7C2D12', '#F59E0B'],
  tone: ['friendly'],
  category: 'Apparel / Saree boutique',
  audience: 'Women 25-45',
  bannedTopics: [],
} as unknown as Brand;

const baseRequest = {
  brandId: 'brand-1',
  productId: 'product-1',
  campaignType: 'generic',
  styleTemplate: 'studio_white',
  outputFormat: 'instagram_post',
  variantCount: 1,
  language: 'en',
} as unknown as CreativeRequest;

const copy = {
  headline: 'Experience the tranquil meadows of Uttarakhand this season',
  caption: 'Long feed caption that does not belong on the poster.',
  hashtags: ['#travel'],
  cta: 'Book your Uttarakhand trip today and save',
  platform: 'instagram',
  language: 'en',
} as unknown as CopyPack;

function context(overrides: {
  request?: Partial<CreativeRequest>;
  rows?: FakeRows;
}): StageContext {
  return {
    brand,
    request: { ...baseRequest, ...overrides.request } as CreativeRequest,
    db: fakeDb(overrides.rows ?? { product: { name: 'Uttarakhand Trip', description: null } }),
    jobId: 'job-1',
  } as unknown as StageContext;
}

describe('composeBrief', () => {
  it('sizes the canvas from the requested output format', async () => {
    const brief = await composeBrief(context({}));
    expect({ width: brief.width, height: brief.height }).toEqual({ width: 1080, height: 1080 });
  });

  it('fails loudly when the product row is missing', async () => {
    await expect(composeBrief(context({ rows: { product: undefined } }))).rejects.toThrow(
      /product-1 not found/i,
    );
  });

  describe('requiredText', () => {
    it('orders the lines by visual weight: headline, offer, wordmark, cta', async () => {
      const brief = await composeBrief(
        context({
          request: { headlineText: 'Monsoon Escape', offerText: '20% OFF', ctaText: 'Book now' },
        }),
      );
      expect(brief.requiredText).toEqual(['Monsoon Escape', '20% OFF', 'DesiWanderer', 'Book now']);
    });

    it('prefers what the customer typed over the generated copy', async () => {
      const brief = await composeBrief(
        context({ request: { headlineText: 'Customer Headline' } }),
        copy,
      );
      expect(brief.requiredText[0]).toBe('Customer Headline');
    });

    it('falls back to the copy stage so an ad is never a bare photograph', async () => {
      const brief = await composeBrief(context({}), copy);
      // Previously copy ran last and requiredText came back empty, which made
      // the prompt say "do not render any text" — hence images with no message.
      expect(brief.requiredText.length).toBeGreaterThan(0);
      expect(brief.requiredText).toContain('DesiWanderer');
    });

    it('always carries the brand wordmark', async () => {
      const brief = await composeBrief(context({}));
      expect(brief.requiredText).toContain('DesiWanderer');
    });

    it('drops blank and whitespace-only overrides rather than demanding empty text', async () => {
      const brief = await composeBrief(
        context({ request: { headlineText: '   ', offerText: '', ctaText: '  ' } }),
      );
      expect(brief.requiredText).toEqual(['DesiWanderer']);
    });
  });

  describe('poster phrasing of feed copy', () => {
    it('shortens a long headline without stranding a dangling word', async () => {
      const brief = await composeBrief(context({}), copy);
      const headline = brief.requiredText[0]!;

      expect(headline.length).toBeLessThanOrEqual(42);
      // The bugs this replaced: "…Serene Meadows of" and "Reserve your".
      expect(headline).not.toMatch(/\b(of|the|and|to|your|for|a|an|with|in|on)$/i);
      expect(headline).not.toMatch(/[,;]$/);
    });

    it('shortens the cta the same way, to a tighter budget', async () => {
      const brief = await composeBrief(context({}), copy);
      const cta = brief.requiredText.at(-1)!;

      expect(cta.length).toBeLessThanOrEqual(28);
      expect(cta).not.toMatch(/\b(of|the|and|to|your|for|a|an|with|in|on)$/i);
    });

    it('keeps a short headline exactly as written', async () => {
      const short = { ...copy, headline: 'Monsoon Escape' } as CopyPack;
      const brief = await composeBrief(context({}), short);
      expect(brief.requiredText[0]).toBe('Monsoon Escape');
    });

    it('takes only the first clause of a headline built around punctuation', async () => {
      const split = { ...copy, headline: 'Taste the Himalayas: our new winter menu' } as CopyPack;
      const brief = await composeBrief(context({}), split);
      expect(brief.requiredText[0]).toBe('Taste the Himalayas');
    });
  });

  describe('prompt', () => {
    it('names the product as the subject', async () => {
      const brief = await composeBrief(context({}));
      expect(brief.prompt).toContain('Uttarakhand Trip');
    });

    it('fences off the brand category so it cannot become the subject', async () => {
      // The saree regression: a travel product rendered as boutique merchandise
      // because the model treated the brand's category as what to photograph.
      const brief = await composeBrief(context({}));
      expect(brief.prompt).toMatch(/Do NOT place its merchandise|styling only/i);
    });

    it('tells the model to depict a service rather than invent an object', async () => {
      const brief = await composeBrief(context({}));
      expect(brief.prompt).toMatch(/service, trip, or experience/i);
    });

    it('asks for the reference photo to be reproduced when one exists', async () => {
      const brief = await composeBrief(
        context({ rows: { product: { name: 'Silk Saree', description: null }, hasImage: true } }),
      );
      expect(brief.prompt).toMatch(/reproduce that item exactly/i);
    });

    it('says nothing about reproducing a reference when there is none', async () => {
      const brief = await composeBrief(context({}));
      expect(brief.prompt).not.toMatch(/reproduce that item exactly/i);
    });

    it('spells out every line of required text for the model to render', async () => {
      const brief = await composeBrief(
        context({ request: { headlineText: 'Monsoon Escape', offerText: '20% OFF' } }),
      );
      for (const line of brief.requiredText) {
        expect(brief.prompt).toContain(line);
      }
    });

    it('appends the product description when the row has one', async () => {
      const brief = await composeBrief(
        context({
          rows: { product: { name: 'Silk Saree', description: 'Handwoven in Banaras.' } },
        }),
      );
      // Trailing punctuation is stripped so the composed sentence has no "..".
      expect(brief.prompt).toContain('Silk Saree — Handwoven in Banaras');
      expect(brief.prompt).not.toContain('..');
    });

    it('surfaces the product selling points as things to show, not to print as text', async () => {
      const brief = await composeBrief(
        context({
          rows: {
            product: {
              name: 'Silk Saree',
              description: null,
              sellingPoints: ['Pure silk', 'Handwoven'],
            },
          },
        }),
      );
      expect(brief.prompt).toContain('Pure silk, Handwoven');
      expect(brief.requiredText).not.toContain('Pure silk');
    });

    it('says nothing about selling points when the product has none', async () => {
      const brief = await composeBrief(context({}));
      expect(brief.prompt).not.toMatch(/selling points/i);
    });

    it('blends more than one brand tone into a single voice line', async () => {
      const multiTone = { ...brand, tone: ['premium', 'traditional'] } as unknown as Brand;
      const brief = await composeBrief({ ...context({}), brand: multiTone });
      expect(brief.prompt).toMatch(/refined, understated, premium, classic and traditional/);
    });

    it('bans the configured topics as an override, not a suggestion', async () => {
      const guarded = { ...brand, bannedTopics: ['politics', 'alcohol'] } as unknown as Brand;
      const brief = await composeBrief({ ...context({}), brand: guarded });
      expect(brief.prompt).toContain('Do not depict or reference, in any form: politics, alcohol');
      expect(brief.prompt).toMatch(/overrides every other instruction/i);
    });

    it('has no banned-topics line when the brand sets none', async () => {
      const brief = await composeBrief(context({}));
      expect(brief.prompt).not.toMatch(/banned|Do not depict or reference/i);
    });
  });
});
