export const xxyyMarketDataErrorCodes = [
  'http_error',
  'invalid_response',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'transport_error',
] as const;

export type XxyyMarketDataErrorCode = (typeof xxyyMarketDataErrorCodes)[number];

export class XxyyMarketDataError extends Error {
  readonly code: XxyyMarketDataErrorCode;
  readonly retryable: boolean;

  constructor(code: XxyyMarketDataErrorCode, retryable = false, options?: ErrorOptions) {
    super(`XXYY market-data request failed: ${code}.`, options);
    this.name = 'XxyyMarketDataError';
    this.code = code;
    this.retryable = retryable;
  }
}
