export const chainAnalysisMcpErrorCodes = [
  'chain_not_configured',
  'invalid_reference',
  'output_too_large',
  'pool_not_configured',
  'provider_unavailable',
  'request_aborted',
  'runtime_not_ready',
  'tool_timeout',
  'tool_failure',
] as const;

export type ChainAnalysisMcpErrorCode = (typeof chainAnalysisMcpErrorCodes)[number];

export class ChainAnalysisMcpToolError extends Error {
  constructor(
    public readonly code: ChainAnalysisMcpErrorCode,
    message = safeMessageForCode(code),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChainAnalysisMcpToolError';
  }
}

export function encodeChainAnalysisMcpError(error: unknown): string {
  return JSON.stringify({ error: classifyChainAnalysisMcpError(error) });
}

export function decodeChainAnalysisMcpError(text: string): ChainAnalysisMcpToolError | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isChainAnalysisMcpErrorCode(value.error)) {
    return undefined;
  }
  return new ChainAnalysisMcpToolError(value.error);
}

export function classifyChainAnalysisMcpError(error: unknown): ChainAnalysisMcpErrorCode {
  if (error instanceof ChainAnalysisMcpToolError) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'request_aborted';
  }
  if (isRecord(error) && typeof error.code === 'string') {
    if (error.code === 'chain_not_configured') {
      return 'chain_not_configured';
    }
    if (error.code === 'pool_not_configured') {
      return 'pool_not_configured';
    }
    if (
      error.code === 'circuit_open' ||
      error.code === 'http_error' ||
      error.code === 'request_timeout' ||
      error.code === 'rpc_error' ||
      error.code === 'transport_error'
    ) {
      return 'provider_unavailable';
    }
  }
  return 'tool_failure';
}

function safeMessageForCode(code: ChainAnalysisMcpErrorCode): string {
  switch (code) {
    case 'chain_not_configured':
      return 'The requested public-chain network is not configured.';
    case 'invalid_reference':
      return 'The transaction reference or network is invalid or ambiguous.';
    case 'output_too_large':
      return 'The chain-analysis result exceeded the governed output limit.';
    case 'pool_not_configured':
      return 'The requested pool is not allowlisted for Sandwich analysis.';
    case 'provider_unavailable':
      return 'The governed chain-data providers are temporarily unavailable.';
    case 'request_aborted':
      return 'The chain-analysis request was aborted.';
    case 'runtime_not_ready':
      return 'The governed chain-analysis runtime is not currently ready.';
    case 'tool_timeout':
      return 'The chain-analysis request exceeded the governed time limit.';
    case 'tool_failure':
      return 'The onchain-analysis MCP tool invocation failed.';
  }
}

function isChainAnalysisMcpErrorCode(value: unknown): value is ChainAnalysisMcpErrorCode {
  return (
    typeof value === 'string' &&
    chainAnalysisMcpErrorCodes.includes(value as ChainAnalysisMcpErrorCode)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
