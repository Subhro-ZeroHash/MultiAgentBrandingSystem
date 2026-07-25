/**
 * Flattens an error and its `cause` chain into a single readable line.
 *
 * `fetch` reports every transport failure as a bare `TypeError: fetch failed`
 * and hangs the only useful detail — ECONNRESET, ETIMEDOUT, a TLS failure — off
 * `cause`. Reading `.message` alone therefore discards the entire diagnosis,
 * which is what made a transient socket drop look identical to a dead API key.
 */
export function describeError(error: unknown, maxDepth = 5): string {
  const seen = new Set<object>();
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth <= maxDepth && current !== undefined && current !== null; depth++) {
    if (typeof current === 'object') {
      if (seen.has(current)) break;
      seen.add(current);
    }

    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      const detail = code === undefined ? '' : ` (${String(code)})`;
      // A connection failure surfaces as an AggregateError with an empty
      // message and one entry per address tried (IPv6 then IPv4). Its message
      // is the empty string, so without this the chain renders as "← ".
      const nested = (current as { errors?: unknown }).errors;
      const first = Array.isArray(nested) ? nested[0] : undefined;
      const text = current.message || (first instanceof Error ? first.message : '');

      const line = `${text}${detail}`.trim();
      // undici repeats the parent's text on the cause often enough that
      // un-deduped chains read as "fetch failed ← fetch failed".
      if (line && parts[parts.length - 1] !== line) parts.push(line);

      current = (current as { cause?: unknown }).cause ?? first;
      continue;
    }

    parts.push(typeof current === 'string' ? current : safeStringify(current));
    break;
  }

  return parts.join(' ← ') || String(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: string, envVar: string) {
    super(`${provider} is not configured — set ${envVar}`, provider, { retryable: false });
    this.name = 'ProviderNotConfiguredError';
  }
}

export class NotImplementedError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(`${provider}.${operation} is not implemented yet`, provider, { retryable: false });
    this.name = 'NotImplementedError';
  }
}
