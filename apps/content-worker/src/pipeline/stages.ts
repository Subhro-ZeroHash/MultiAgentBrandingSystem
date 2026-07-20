import type { AiRegistry } from '@bmas/ai';
import type { Brand } from '@bmas/db';
import type { CopyPack, CreativeRequest } from '@bmas/shared';

/**
 * The four pipeline stages. Each is a pure-ish function of (registry, input) so
 * a stage can be tested, reordered, or retried independently — this is the
 * pattern the later agents (video, publishing, monitoring) will follow.
 */

export interface StageContext {
  ai: AiRegistry;
  brand: Brand;
  request: CreativeRequest;
}

/**
 * Stage 1 — brief. Turns the structured intake plus the Brand Kit into the
 * generation prompt. The user never writes a prompt (FR-2.3), so all prompt
 * craft lives here.
 *
 * TODO(content): compose from the style template, brand colors, tone, product
 * description, and the required on-image text.
 */
export async function composeBrief(_ctx: StageContext): Promise<{ prompt: string }> {
  throw new Error('composeBrief is not implemented yet');
}

/**
 * Stage 2 — image. Fans out `variantCount` variants through
 * `ai.imageGenerator()`, conditioned on the cleaned product photos and logo.
 *
 * TODO(content): call the registry, upload results to object storage, return keys.
 */
export async function generateImages(
  _ctx: StageContext,
  _brief: { prompt: string },
): Promise<Array<{ storageKey: string; width: number; height: number }>> {
  throw new Error('generateImages is not implemented yet');
}

/**
 * Stage 3 — QA. Reads on-image text back with a vision model and flags
 * misspellings; auto-retries once on failure (FR-3.5). Also the natural home
 * for the programmatic logo-overlay fallback (FR-3.4) when the model mangles
 * the logo.
 *
 * TODO(content): implement with `ai.llm().analyzeImage({ role: 'qa', ... })`
 * and `sharp` for the compositing fallback.
 */
export async function qaImages(
  _ctx: StageContext,
  _images: Array<{ storageKey: string }>,
): Promise<Array<{ storageKey: string; passed: boolean; detectedText: string }>> {
  throw new Error('qaImages is not implemented yet');
}

/**
 * Stage 4 — copy. Generates the platform-aware copy pack in the Brand Kit's
 * tone (FR-4.1, FR-4.2). Runs on the `volume` model role since it fans out per
 * platform and is the cheapest stage to get wrong-and-retry.
 *
 * TODO(content): implement with `ai.llm().generateJson({ role: 'volume', ... })`.
 */
export async function generateCopy(_ctx: StageContext): Promise<CopyPack[]> {
  throw new Error('generateCopy is not implemented yet');
}
