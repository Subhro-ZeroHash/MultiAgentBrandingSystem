import { ProviderNotConfiguredError, ProviderError, describeError } from '../errors.js';
import type {
  LlmJsonRequest,
  LlmService,
  LlmTextRequest,
  LlmVisionRequest,
  ModelRole,
} from '../llm.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface OllamaAdapterConfig {
  baseUrl: string | undefined;
  model: string | undefined;
  /** Ollama runs locally, so cost is always zero. */
  models?: Record<ModelRole, string>;
}

// The model's own default context (4096 for gemma4:e4b, confirmed via
// `ollama ps`) is shared between the input prompt and the output — a large
// structured schema (e.g. 8 scored trend opportunities) plus its search-result
// context can leave too little room for the model to finish the JSON array,
// producing syntactically invalid, truncated output rather than an error.
// Ollama accepts a per-request override, so this widens the window without
// touching the model's own Modelfile default.
const NUM_CTX = 8192;
// Raising num_ctx alone was not enough: live testing against a real 8-item
// trend-opportunity schema still truncated mid-array with zero closing braces
// anywhere in the output, at varying positions between runs — the output
// length itself was being capped independently of how much context was
// available. `num_predict` is Ollama's separate max-output-tokens setting
// (its own server-side default is small); -1 removes that ceiling so
// generation runs until the model reaches a natural stop or NUM_CTX itself,
// rather than an arbitrary shorter cutoff.
const NUM_PREDICT = -1;

/**
 * Reasoning models (gemma4 among them) split their output in two: reasoning
 * into a separate `thinking` field, answer into `content`. Left on, two things
 * break. The whole response sometimes lands in `thinking` with `content` empty
 * — surfacing as "No content in response" — and what does reach `content`
 * arrives noisier, e.g. ``json\n{```json\n{"ok":true}\n``` `` (a stray brace
 * and a bare `json` line wrapped around a fenced block). Off, the same call
 * returns a clean fenced object. `extractJsonObject` below still has to cope
 * with fences, since disabling thinking does not stop a model from adding
 * them.
 */
const THINK = false;

/**
 * Pulls the first parseable JSON object out of a model's raw text.
 *
 * Small local models wrap JSON in markdown fences, prefix it with a bare
 * `json` line, emit a stray unmatched brace, or append prose after the
 * object — often several at once. The previous first-`{`-to-last-`}` regex
 * took the fence backticks with it and died on "Expected property name or
 * '}'", which is exactly what reached the app.
 *
 * So: strip fences, then walk each `{` in turn, take the balanced object
 * starting there (quote- and escape-aware, so braces inside strings don't
 * confuse the depth count), and return the first one that actually parses.
 * Starting at *each* brace rather than only the first is what makes a stray
 * leading brace survivable. Returns undefined when nothing parses, which
 * includes the genuinely-truncated case worth retrying.
 */
export function extractJsonObject(raw: string): unknown | undefined {
  const cleaned = raw.replace(/```[a-zA-Z]*/g, '');

  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            // Balanced but not valid JSON — try the next opening brace.
          }
          break;
        }
      }
    }
  }

  return undefined;
}

/**
 * Local Ollama adapter for development and testing when commercial API keys
 * are unavailable. Ollama runs on localhost by default.
 *
 * Use with: LLM_PROVIDER=ollama, OLLAMA_BASE_URL=http://localhost:11434
 */
export class OllamaLlmAdapter implements LlmService {
  readonly provider = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: OllamaAdapterConfig) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'gemma4:e4b';
  }

  private require(): void {
    if (!this.baseUrl) {
      throw new ProviderNotConfiguredError('ollama', 'OLLAMA_BASE_URL');
    }
  }

  /**
   * Generates plain text via Ollama's chat endpoint.
   */
  async generateText(req: LlmTextRequest, ctx?: ProviderContext): Promise<ProviderResult<string>> {
    this.require();

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            ...req.messages,
          ],
          stream: false,
          think: THINK,
          options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT },
          // Temperature defaults: Ollama uses 0.7. Requests with no explicit
          // temp get Ollama's default, which is reasonable for variety.
        }),
        signal: ctx?.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ProviderError(`Ollama returned ${response.status}: ${error}`, 'ollama', {
          retryable: response.status >= 500,
        });
      }

      const result = (await response.json()) as {
        message?: { content: string };
        error?: string;
      };

      if (result.error) {
        throw new ProviderError(result.error, 'ollama', { retryable: false });
      }

      if (!result.message?.content) {
        throw new ProviderError('No content in response', 'ollama', { retryable: false });
      }

      return {
        value: result.message.content,
        cost: buildCostEvent({
          provider: 'ollama',
          model: this.model,
          operation: 'generateText',
          inputTokens: 0, // Ollama runs locally; token counts are not exposed
          outputTokens: 0,
        }),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Ollama request failed: ${describeError(error)}`, 'ollama', {
        retryable: true,
        cause: error as Error,
      });
    }
  }

  /**
   * Generates JSON via Ollama by asking for structured output.
   * Ollama doesn't support JSON schema validation, so the prompt must
   * explicitly ask for valid JSON and the caller must parse it.
   */
  async generateJson<T>(
    req: LlmJsonRequest<T>,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<T>> {
    this.require();

    // The schema still goes in the prompt so the model knows which fields to
    // fill in, but `format` is what actually enforces JSON output — Ollama
    // constrains decoding to the given JSON Schema at the token level, unlike
    // a prompt instruction the model is free to ignore. Without this, a small
    // model asked for a large schema (e.g. 8 scored opportunities) may answer
    // in prose instead, which the caller then can't parse as JSON at all.
    const schemaJson = JSON.stringify(req.schema, null, 2);
    const systemPrompt = `${req.system ?? 'You are a helpful assistant.'} Respond with valid JSON matching this schema:
${schemaJson}`;

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            ...req.messages.map((msg) => ({
              ...msg,
              content: Array.isArray(msg.content) ? msg.content[0] : msg.content,
            })),
          ],
          format: req.schema,
          stream: false,
          think: THINK,
          options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT },
        }),
        signal: ctx?.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ProviderError(`Ollama returned ${response.status}: ${error}`, 'ollama', {
          retryable: response.status >= 500,
        });
      }

      const result = (await response.json()) as {
        message?: { content: string };
        error?: string;
      };

      if (result.error) {
        throw new ProviderError(result.error, 'ollama', { retryable: false });
      }

      if (!result.message?.content) {
        throw new ProviderError('No content in response', 'ollama', { retryable: false });
      }

      const parsed = extractJsonObject(result.message.content);
      if (parsed === undefined) {
        // Retryable: the usual cause is a truncated or fence-mangled
        // generation, which a rerun typically fixes — same reasoning the
        // schema-mismatch branch below documents.
        throw new ProviderError(
          `No parseable JSON in response: ${result.message.content.slice(0, 200)}`,
          'ollama',
          { retryable: true },
        );
      }

      // Every other adapter runs the caller's schema through `req.parse` —
      // callers rely on it not just to narrow the type but to validate and
      // clip (see e.g. trend-research.ts's clipRelevanceCounts) values a
      // small local model is more likely to get out of range than a hosted
      // one. Skipping it here let unvalidated, unclipped JSON reach callers
      // that assume it had already been checked.
      let value: T;
      try {
        value = req.parse(parsed);
      } catch (error) {
        // Retryable, same reasoning the Anthropic and Gemini adapters already
        // document for this exact case: a small local model is more likely
        // than a hosted one to miss the schema on a given attempt, and a
        // rerun usually fits. Left non-retryable, one bad generation kills
        // the whole run outright instead of getting the second chance
        // `withRetry` exists to provide.
        throw new ProviderError(
          `Ollama response did not match the expected schema — ${describeError(error)}`,
          'ollama',
          { retryable: true, cause: error as Error },
        );
      }

      return {
        value,
        cost: buildCostEvent({
          provider: 'ollama',
          model: this.model,
          operation: 'generateJson',
          inputTokens: 0,
          outputTokens: 0,
        }),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof SyntaxError) {
        // Same "rerun usually fits" reasoning as the schema-mismatch branch
        // above, and the same classification Anthropic/Gemini give truncated
        // JSON — this is the failure mode this file's NUM_CTX/NUM_PREDICT
        // comments describe fighting, not a permanent one.
        throw new ProviderError(`JSON parse failed: ${error.message}`, 'ollama', {
          retryable: true,
        });
      }
      throw new ProviderError(`Ollama request failed: ${describeError(error)}`, 'ollama', {
        retryable: true,
        cause: error as Error,
      });
    }
  }

  /**
   * Analyzes images via Ollama. Ollama supports image input if the model
   * supports it (e.g., llava). The image must be base64-encoded.
   */
  async analyzeImage(
    req: LlmVisionRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<string>> {
    this.require();

    try {
      // Build messages with image data
      const messages = req.images.map((img) => ({
        role: 'user' as const,
        content: req.prompt,
        images: [img.data], // Ollama expects base64 image data
      }));

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          think: THINK,
          options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT },
        }),
        signal: ctx?.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ProviderError(`Ollama returned ${response.status}: ${error}`, 'ollama', {
          retryable: response.status >= 500,
        });
      }

      const result = (await response.json()) as {
        message?: { content: string };
        error?: string;
      };

      if (result.error) {
        throw new ProviderError(result.error, 'ollama', { retryable: false });
      }

      if (!result.message?.content) {
        throw new ProviderError('No content in response', 'ollama', { retryable: false });
      }

      return {
        value: result.message.content,
        cost: buildCostEvent({
          provider: 'ollama',
          model: this.model,
          operation: 'generateText',
          inputTokens: 0,
          outputTokens: 0,
        }),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Ollama request failed: ${describeError(error)}`, 'ollama', {
        retryable: true,
        cause: error as Error,
      });
    }
  }
}
