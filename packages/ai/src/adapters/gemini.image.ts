import { NotImplementedError } from '../errors.js';
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGenService,
} from '../image.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface GeminiImageConfig {
  apiKey: string | undefined;
  model?: string;
}

/**
 * Primary image generator (PRD §7.2): multi-reference product fidelity plus
 * legible, multilingual on-image text.
 *
 * TODO(content): implement with `@google/genai` — pass the cleaned product
 * photos and the logo as inline image parts alongside the composed prompt, and
 * return one `GeneratedImage` per requested variant. Model id and per-image
 * pricing are pinned in config (`IMAGE_MODEL_GEMINI`) precisely because they
 * change often; confirm both against live docs during the provider spike before
 * filling this in.
 */
export class GeminiImageAdapter implements ImageGenService {
  readonly provider = 'google';

  constructor(private readonly config: GeminiImageConfig) {}

  async generate(
    _req: ImageGenerateRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage[]>> {
    throw new NotImplementedError('google', 'generate');
  }

  async edit(
    _req: ImageEditRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage>> {
    throw new NotImplementedError('google', 'edit');
  }
}
