import { chainAnalysisCapabilitiesSchema, type ChainAnalysisHandler } from './contracts.js';
import { ChainAnalysisMcpToolError } from './errors.js';

export interface CreateReadinessGuardedChainAnalysisHandlerOptions {
  handler: ChainAnalysisHandler;
  now?: () => Date;
  readyFrom: string;
  readyUntil: string;
}

export function createReadinessGuardedChainAnalysisHandler(
  options: CreateReadinessGuardedChainAnalysisHandlerOptions,
): ChainAnalysisHandler {
  const readyFromMs = parseTimestamp(options.readyFrom, 'readyFrom');
  const readyUntilMs = parseTimestamp(options.readyUntil, 'readyUntil');
  if (readyUntilMs <= readyFromMs) {
    throw new TypeError('Chain-analysis readiness window must have positive duration.');
  }
  const now = options.now ?? (() => new Date());

  const isReady = (): boolean => {
    const currentTimeMs = now().getTime();
    return currentTimeMs >= readyFromMs && currentTimeMs < readyUntilMs;
  };
  const assertReady = (): void => {
    if (!isReady()) {
      throw new ChainAnalysisMcpToolError('runtime_not_ready');
    }
  };

  return {
    async detectSandwich(input, requestOptions) {
      assertReady();
      return options.handler.detectSandwich(input, requestOptions);
    },
    getCapabilities() {
      const capabilities = options.handler.getCapabilities();
      return chainAnalysisCapabilitiesSchema.parse({
        ...capabilities,
        runtimeStatus: isReady() ? 'ready' : 'degraded',
      });
    },
    async getTransaction(input, requestOptions) {
      assertReady();
      return options.handler.getTransaction(input, requestOptions);
    },
    async inspectTransaction(input, requestOptions) {
      assertReady();
      return options.handler.inspectTransaction(input, requestOptions);
    },
  };
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`Chain-analysis ${label} must be an ISO timestamp.`);
  }
  return timestamp;
}
