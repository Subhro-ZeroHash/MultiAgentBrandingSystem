import type { ProviderContext, ProviderResult } from './types.js';

export interface ReferenceImage {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Hint for the model, e.g. "product photo" | "brand logo". */
  label?: string;
}

export interface GeneratedImage {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  model: string;
}

export interface ImageGenerateRequest {
  /** Composed by the brief stage from the style template — never user-authored. */
  prompt: string;
  /** Product photos + logo used as visual conditioning (FR-3.1). */
  references: ReferenceImage[];
  width: number;
  height: number;
  /** Number of variants to fan out (FR-3.2). */
  count: number;
  /** Text that must render legibly and correctly spelled. */
  requiredText?: string[];
  brandColors?: string[];
}

/** Targeted edit of an existing image (FR-3.3) — not a regeneration. */
export interface ImageEditRequest {
  image: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  instruction: string;
  references?: ReferenceImage[];
}

/**
 * The abstraction that lets us ride the model-release treadmill. Provider
 * adapters are selected per operation by the registry; no product code
 * constructs one directly.
 */
export interface ImageGenService {
  readonly provider: string;

  generate(
    req: ImageGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage[]>>;

  edit(req: ImageEditRequest, ctx?: ProviderContext): Promise<ProviderResult<GeneratedImage>>;
}
