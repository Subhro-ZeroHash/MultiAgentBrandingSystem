import type { ProviderContext, ProviderResult } from './types.js';

/** Which tier of model a call should route to. Resolved by the registry. */
export type ModelRole = 'orchestrator' | 'volume' | 'qa';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmTextRequest {
  role: ModelRole;
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  /** Adaptive thinking + effort; see packages/ai/src/adapters/anthropic.ts. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LlmJsonRequest<T> extends LlmTextRequest {
  /** JSON Schema the response is constrained to. */
  schema: Record<string, unknown>;
  /** Runtime validation of the parsed payload. */
  parse: (raw: unknown) => T;
}

export interface LlmVisionRequest extends Omit<LlmTextRequest, 'messages'> {
  prompt: string;
  images: Array<{ data: Buffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }>;
}

/**
 * The only text-LLM surface product code may use. No module outside
 * `src/adapters` imports a provider SDK.
 */
export interface LlmService {
  readonly provider: string;

  generateText(req: LlmTextRequest, ctx?: ProviderContext): Promise<ProviderResult<string>>;

  generateJson<T>(req: LlmJsonRequest<T>, ctx?: ProviderContext): Promise<ProviderResult<T>>;

  /** Used by the content QA pass to read text back off a rendered image. */
  analyzeImage(req: LlmVisionRequest, ctx?: ProviderContext): Promise<ProviderResult<string>>;
}
