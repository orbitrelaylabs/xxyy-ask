export const solanaDataAdapterErrorCodes = [
  'endpoint_not_allowed',
  'http_error',
  'invalid_configuration',
  'invalid_json',
  'invalid_jsonrpc',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'rpc_error',
  'transport_error',
] as const;

export type SolanaDataAdapterErrorCode = (typeof solanaDataAdapterErrorCodes)[number];

export class SolanaDataAdapterError extends Error {
  readonly code: SolanaDataAdapterErrorCode;
  readonly httpStatus: number | undefined;
  readonly providerId: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: SolanaDataAdapterErrorCode,
    message: string,
    options: {
      cause?: unknown;
      httpStatus?: number;
      providerId?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SolanaDataAdapterError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.providerId = options.providerId;
    this.retryable = options.retryable ?? false;
  }
}
