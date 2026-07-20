import type { CostEvent } from '@bmas/shared';

/**
 * Every adapter returns its payload alongside the cost of producing it. Callers
 * persist `cost` to `core.cost_events` — this is why cost telemetry can't be
 * forgotten: it comes back in the same object as the result.
 */
export interface ProviderResult<T> {
  value: T;
  cost: CostEvent;
}

export interface ProviderContext {
  /** Correlation id — a generation job id or probe run id. */
  referenceId?: string;
  brandId?: string;
  /** Aborts the underlying request; workers pass their job's signal. */
  signal?: AbortSignal;
}

export type ProviderName = 'anthropic' | 'google' | 'fal' | 'openai' | 'perplexity';
