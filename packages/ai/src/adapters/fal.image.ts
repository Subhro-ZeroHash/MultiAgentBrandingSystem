import { NotImplementedError } from '../errors.js';
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGenService,
} from '../image.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface FalImageConfig {
  apiKey: string | undefined;
  editModel?: string;
}

/**
 * Second adapter, live from launch (PRD R4): Flux Kontext via fal.ai handles
 * targeted edits and stands in as failover when the primary provider changes
 * policy or pricing. Having two adapters behind `ImageGenService` is what makes
 * that switch a config change rather than a rewrite.
 *
 * TODO(content): implement with `@fal-ai/client` — `edit` is the priority path,
 * `generate` only matters if we route bulk variants here on cost grounds.
 */
export class FalImageAdapter implements ImageGenService {
  readonly provider = 'fal';

  constructor(private readonly config: FalImageConfig) {}

  async generate(
    _req: ImageGenerateRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage[]>> {
    throw new NotImplementedError('fal', 'generate');
  }

  async edit(
    _req: ImageEditRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage>> {
    throw new NotImplementedError('fal', 'edit');
  }
}
