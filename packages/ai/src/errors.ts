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
