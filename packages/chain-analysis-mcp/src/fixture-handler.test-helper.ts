import { createSyntheticChainAnalysisCorpus } from '@xxyy/evm-chain-analysis-harness/test-fixtures';
import {
  EVM_EXECUTION_DATA_ADAPTER_VERSION,
  evmExecutionDataAdapterResultSchema,
  type LoadEvmExecutionDataInput,
} from '@xxyy/evm-execution-data-adapter';
import type { ChainAnalysisHandler } from './contracts.js';
import { createChainAnalysisHandler, type ChainAnalysisDataPlane } from './service.js';

export interface ChainAnalysisFixtureRuntime {
  chainId: string;
  executionInputs: LoadEvmExecutionDataInput[];
  handler: ChainAnalysisHandler;
  poolAddress?: string;
  transactionHash: string;
}

export async function createChainAnalysisFixtureRuntime(
  caseId: 'synthetic.confirmed-v2' | 'synthetic.inspect-execution',
): Promise<ChainAnalysisFixtureRuntime> {
  const corpus = await createSyntheticChainAnalysisCorpus();
  const item = corpus.cases.find((candidate) => candidate.id === caseId);
  if (item === undefined) {
    throw new Error(`Missing synthetic chain-analysis case: ${caseId}.`);
  }
  const detectRequest = item.input.requests.find(
    (request) => request.capability === 'chain.detect_sandwich',
  );
  const protocol =
    caseId === 'synthetic.confirmed-v2' ? ('uniswap_v2' as const) : ('uniswap_v3' as const);
  const poolAddress =
    detectRequest?.capability === 'chain.detect_sandwich'
      ? detectRequest.poolAddress
      : '0x2222222222222222222222222222222222222222';
  const executionInputs: LoadEvmExecutionDataInput[] = [];
  const executionResult = evmExecutionDataAdapterResultSchema.parse({
    conflicts: [],
    diagnostics: [],
    poolMetadata: [],
    status: 'success',
    ...(item.input.execution?.trace === undefined ? {} : { trace: item.input.execution.trace }),
    verifiedPools: [],
    version: EVM_EXECUTION_DATA_ADAPTER_VERSION,
  });
  const dataPlane: ChainAnalysisDataPlane = {
    execution: {
      listConfiguredChains: () => [
        {
          chainId: item.input.snapshot.chainId,
          protocols: ['uniswap_v2', 'uniswap_v3'],
          providerIds: ['execution-a', 'execution-b'],
        },
      ],
      loadExecutionData(input) {
        executionInputs.push(input);
        return Promise.resolve(executionResult);
      },
    },
    mevObservation: {
      listConfiguredChains: () => [
        {
          chainId: item.input.snapshot.chainId,
          pools: [{ poolAddress, protocol }],
          providerIds: ['observation-a', 'observation-b'],
        },
      ],
      loadObservation() {
        if (item.input.observation === undefined) {
          return Promise.reject(new Error('Fixture does not provide an MEV observation.'));
        }
        return Promise.resolve(structuredClone(item.input.observation));
      },
    },
    snapshot: {
      listConfiguredChains: () => [
        {
          chainId: item.input.snapshot.chainId,
          providerIds: ['snapshot-a', 'snapshot-b'],
        },
      ],
      loadTransactionSnapshot() {
        return Promise.resolve({
          diagnostics: [],
          snapshot: structuredClone(item.input.snapshot),
          status: 'success',
        });
      },
    },
  };
  return {
    chainId: item.input.snapshot.chainId,
    executionInputs,
    handler: createChainAnalysisHandler({ dataPlane, runtimeStatus: 'internal' }),
    ...(detectRequest?.capability === 'chain.detect_sandwich'
      ? { poolAddress: detectRequest.poolAddress }
      : {}),
    transactionHash: item.input.snapshot.requestedTransactionHash,
  };
}
