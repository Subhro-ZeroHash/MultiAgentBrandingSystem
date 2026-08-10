import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { AiRegistry } from '@bmas/ai';
import {
  desc,
  eq,
  getTrendContext,
  renderBrandContextLines,
  schema,
  type Database,
} from '@bmas/db';
import { z } from 'zod';
import { AI_REGISTRY, DATABASE } from '../core/core.module.js';

/**
 * "Ask about your brand..." — the AI Research prompt box.
 *
 * Not a third research pipeline: no run row, no BullMQ job, no worker. A
 * question answered inline is a single request/response the way a chat
 * message is — queuing it would only add latency nobody asked for. What it
 * shares with the two agents that *are* pipelines is the grounding
 * discipline: one real web search first, then an LLM call constrained to what
 * that search actually returned, sources verified against the results before
 * they reach the user. An AI answering from training data alone about "events
 * in Pune this month" would be answering a question it cannot actually know
 * the answer to.
 */

const SEARCH_TIMEOUT_MS = 15_000;
const ANSWER_TIMEOUT_MS = 45_000;
const MAX_ANSWER_TOKENS = 2_000;
const MAX_SNIPPET_CHARS = 500;
const RESULTS_PER_SEARCH = 8;

const answerSchema = z.object({
  answer: z.string().min(1).max(2000),
  sources: z
    .array(z.object({ url: z.string().url(), title: z.string().max(300).nullable() }))
    .max(6),
});

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'sources'],
  properties: {
    answer: {
      type: 'string',
      description:
        'A direct, specific answer to the question, grounded in the search results below. ' +
        'Plain prose, 2-6 sentences — not a list of the search results themselves.',
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: { url: { type: 'string' }, title: { type: ['string', 'null'] } },
      },
      description: 'Only URLs that actually appear in the search results below. Never invent one.',
    },
  },
} as const;

@Injectable()
export class AiResearchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_REGISTRY) private readonly ai: AiRegistry,
  ) {}

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

  /**
   * Answers one question, surfacing a provider failure as something readable.
   *
   * Unlike trend and intelligence research — which persist a run row and put
   * the provider's own message in its `error` column, so the client reads the
   * real reason — this path is synchronous and has nowhere to record that. A
   * raw `ProviderError` reaching Nest's default filter becomes a bare 500
   * "Internal server error", which is exactly what the prompt box was
   * showing while the Gemini key sat at zero credits: the one screen in the
   * app that could not tell you why it failed. 503 rather than 500 because a
   * depleted quota or a provider outage is a temporary upstream condition,
   * not a defect in this request.
   */
  async ask(brandId: string, ownerId: string, question: string) {
    try {
      return await this.askOnce(brandId, ownerId, question);
    } catch (error) {
      // Ownership and validation failures are already the right HTTP shape;
      // only unrecognised (provider/transport) errors need translating.
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        `The AI provider could not answer right now — ${describeError(error)}`,
      );
    }
  }

  private async askOnce(brandId: string, ownerId: string, question: string) {
    await this.assertBrandOwned(brandId, ownerId);

    // Same Context Manager reasoning as trend research: the question arrives
    // with no brand details attached, and the active Brand Brain supplies
    // them — the user should never have to repeat their industry, location,
    // or products in the prompt box.
    const brandContext = await getTrendContext(this.db, brandId);

    const { value: results } = await withRetry(() =>
      withTimeout(
        this.ai.webSearch().search(
          {
            // The question itself carries the specific ask; brand context
            // narrows which "events" or "trends" are meant. Folding both
            // into one query keeps this to the single search a chat-style
            // answer can afford — unlike trend/intelligence research, there
            // is no multi-category fan-out here.
            query:
              `${question} ${brandContext.identity.industry ?? ''} ${brandContext.identity.location ?? ''}`.trim(),
            topic: 'general',
            recencyDays: 30,
            maxResults: RESULTS_PER_SEARCH,
          },
          { brandId, referenceId: `ai-research-${Date.now()}` },
        ),
        SEARCH_TIMEOUT_MS,
        'AI research search',
      ),
    );

    const signalText = results.length
      ? results
          .map((r, i) => {
            const date = r.publishedAt ? ` (${r.publishedAt})` : '';
            return `${i + 1}. [${r.title ?? 'Untitled'}]${date} — ${r.url}\n   ${r.snippet.slice(0, MAX_SNIPPET_CHARS)}`;
          })
          .join('\n')
      : '(search returned nothing)';

    const { value: parsed } = await withRetry(() =>
      withTimeout(
        this.ai.llm().generateJson<z.infer<typeof answerSchema>>(
          {
            role: 'orchestrator',
            system:
              'You answer one specific question about one small business, grounded in the live ' +
              'search results you are given. Never invent a fact, date, or event that is not ' +
              'actually present in the results. If the results do not actually answer the ' +
              'question, say so plainly rather than filling the gap from general knowledge.',
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  ...renderBrandContextLines(brandContext),
                  '',
                  `**Question:** ${question}`,
                  '',
                  '**Live search results:**',
                  signalText,
                ].join('\n'),
              },
            ],
            maxTokens: MAX_ANSWER_TOKENS,
            schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => answerSchema.parse(raw),
          },
          { brandId, referenceId: `ai-research-${Date.now()}` },
        ),
        ANSWER_TIMEOUT_MS,
        'AI research answer',
      ),
    );

    const known = new Set(results.map((r) => r.url));
    const sources = parsed.sources.filter((source) => known.has(source.url));

    const [saved] = await this.db
      .insert(schema.aiResearchQueries)
      .values({ brandId, question, answer: parsed.answer, sources })
      .returning();
    if (!saved) throw new Error('Insert returned no row');

    return saved;
  }

  private parseLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) return 20;
    return Math.min(100, Math.max(1, Math.floor(raw)));
  }

  async listHistory(brandId: string, ownerId: string, limit?: number) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db
      .select()
      .from(schema.aiResearchQueries)
      .where(eq(schema.aiResearchQueries.brandId, brandId))
      .orderBy(desc(schema.aiResearchQueries.createdAt))
      .limit(this.parseLimit(limit));
  }
}
