import {
  composeEvmChainAnalysis,
  type EvmChainAnalysisPipelineResult,
} from '@xxyy/evm-chain-analysis-harness';
import type { EvmDataAdapter } from '@xxyy/evm-data-adapter';
import type { EvmExecutionDataAdapter } from '@xxyy/evm-execution-data-adapter';
import { UNISWAP_V2_SWAP_TOPIC, UNISWAP_V3_SWAP_TOPIC } from '@xxyy/evm-execution-enrichment-core';
import type { EvmMevObservationDataAdapter } from '@xxyy/evm-mev-observation-data-adapter';
import type { EvmTransactionSnapshot } from '@xxyy/transaction-analysis-core';

import {
  CHAIN_ANALYSIS_MCP_VERSION,
  DETECT_SANDWICH_TOOL_NAME,
  INSPECT_TRANSACTION_TOOL_NAME,
  chainAnalysisCapabilitiesSchema,
  detectSandwichInputSchema,
  detectSandwichOutputSchema,
  inspectTransactionInputSchema,
  inspectTransactionOutputSchema,
  type ChainAnalysisCapabilities,
  type ChainAnalysisHandler,
  type ChainAnalysisRuntimeStatus,
  type DetectSandwichOutput,
  type InspectTransactionOutput,
} from './contracts.js';
import { ChainAnalysisMcpToolError } from './errors.js';

export interface ChainAnalysisDataPlane {
  execution: Pick<EvmExecutionDataAdapter, 'listConfiguredChains' | 'loadExecutionData'>;
  mevObservation: Pick<EvmMevObservationDataAdapter, 'listConfiguredChains' | 'loadObservation'>;
  snapshot: Pick<EvmDataAdapter, 'listConfiguredChains' | 'loadTransactionSnapshot'>;
}

export interface CreateChainAnalysisHandlerOptions {
  dataPlane: ChainAnalysisDataPlane;
  runtimeStatus?: ChainAnalysisRuntimeStatus;
}

export function createChainAnalysisHandler(
  options: CreateChainAnalysisHandlerOptions,
): ChainAnalysisHandler {
  const capabilities = createCapabilities(options.dataPlane, options.runtimeStatus ?? 'internal');

  return {
    async detectSandwich(rawInput, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted();
      const input = detectSandwichInputSchema.parse(rawInput);
      assertToolEnabled(capabilities, input.chainId, DETECT_SANDWICH_TOOL_NAME);
      const pool = findConfiguredPool(options.dataPlane, input.chainId, input.poolAddress);
      const snapshotResult = await options.dataPlane.snapshot.loadTransactionSnapshot(
        {
          chainId: input.chainId,
          transactionHash: input.transactionHash,
        },
        signalOptions(requestOptions.signal),
      );
      requestOptions.signal?.throwIfAborted();
      const blockNumber = resolveBlockNumber(snapshotResult.snapshot);
      const [executionResult, observation] = await Promise.all([
        blockNumber === undefined
          ? Promise.resolve(undefined)
          : options.dataPlane.execution.loadExecutionData(
              {
                blockNumber,
                chainId: input.chainId,
                pools: [pool],
                transactionHash: input.transactionHash,
              },
              signalOptions(requestOptions.signal),
            ),
        options.dataPlane.mevObservation.loadObservation(
          {
            chainId: input.chainId,
            poolAddress: input.poolAddress,
            targetTransactionHash: input.transactionHash,
          },
          signalOptions(requestOptions.signal),
        ),
      ]);
      requestOptions.signal?.throwIfAborted();
      const execution = toExecutionInput(executionResult);
      const pipeline = composeEvmChainAnalysis({
        ...(execution === undefined ? {} : { execution }),
        observation,
        requests: [
          {
            capability: 'chain.detect_sandwich',
            chainId: input.chainId,
            poolAddress: input.poolAddress,
            transactionHash: input.transactionHash,
          },
        ],
        snapshot: snapshotResult.snapshot,
      });
      return projectSandwichOutput(pipeline);
    },

    getCapabilities() {
      return capabilities;
    },

    async inspectTransaction(rawInput, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted();
      const input = inspectTransactionInputSchema.parse(rawInput);
      assertToolEnabled(capabilities, input.chainId, INSPECT_TRANSACTION_TOOL_NAME);
      const snapshotResult = await options.dataPlane.snapshot.loadTransactionSnapshot(
        input,
        signalOptions(requestOptions.signal),
      );
      requestOptions.signal?.throwIfAborted();
      const blockNumber = resolveBlockNumber(snapshotResult.snapshot);
      const executionResult =
        blockNumber === undefined
          ? undefined
          : await options.dataPlane.execution.loadExecutionData(
              {
                blockNumber,
                chainId: input.chainId,
                pools: derivePoolCandidates(snapshotResult.snapshot),
                transactionHash: input.transactionHash,
              },
              signalOptions(requestOptions.signal),
            );
      requestOptions.signal?.throwIfAborted();
      const execution = toExecutionInput(executionResult);
      const pipeline = composeEvmChainAnalysis({
        ...(execution === undefined ? {} : { execution }),
        requests: [
          {
            capability: 'chain.inspect_transaction',
            chainId: input.chainId,
            transactionHash: input.transactionHash,
          },
        ],
        snapshot: snapshotResult.snapshot,
      });
      return projectInspectionOutput(pipeline);
    },
  };
}

function createCapabilities(
  dataPlane: ChainAnalysisDataPlane,
  runtimeStatus: ChainAnalysisRuntimeStatus,
): ChainAnalysisCapabilities {
  const executionByChain = new Map(
    dataPlane.execution
      .listConfiguredChains()
      .map((chain) => [chain.chainId, chain.protocols] as const),
  );
  const observationByChain = new Map(
    dataPlane.mevObservation.listConfiguredChains().map((chain) => [chain.chainId, chain] as const),
  );
  const chains = dataPlane.snapshot.listConfiguredChains().map((chain) => {
    const protocols = [...new Set(executionByChain.get(chain.chainId) ?? [])].sort();
    const tools: Array<typeof INSPECT_TRANSACTION_TOOL_NAME | typeof DETECT_SANDWICH_TOOL_NAME> = [
      INSPECT_TRANSACTION_TOOL_NAME,
    ];
    if ((observationByChain.get(chain.chainId)?.pools.length ?? 0) > 0) {
      tools.push(DETECT_SANDWICH_TOOL_NAME);
    }
    return { chainId: chain.chainId, protocols, tools };
  });
  return chainAnalysisCapabilitiesSchema.parse({
    chains,
    runtimeStatus,
    version: CHAIN_ANALYSIS_MCP_VERSION,
  });
}

function assertToolEnabled(
  capabilities: ChainAnalysisCapabilities,
  chainId: string,
  tool: typeof INSPECT_TRANSACTION_TOOL_NAME | typeof DETECT_SANDWICH_TOOL_NAME,
): void {
  if (
    !capabilities.chains.some((chain) => chain.chainId === chainId && chain.tools.includes(tool))
  ) {
    throw new ChainAnalysisMcpToolError('chain_not_configured');
  }
}

function findConfiguredPool(
  dataPlane: ChainAnalysisDataPlane,
  chainId: string,
  poolAddress: string,
): { poolAddress: string; protocol: 'uniswap_v2' | 'uniswap_v3' } {
  const pool = dataPlane.mevObservation
    .listConfiguredChains()
    .find((chain) => chain.chainId === chainId)
    ?.pools.find((candidate) => candidate.poolAddress === poolAddress);
  if (pool === undefined) {
    throw new ChainAnalysisMcpToolError('pool_not_configured');
  }
  return pool;
}

function resolveBlockNumber(snapshot: EvmTransactionSnapshot): string | undefined {
  return snapshot.transaction?.blockNumber ?? snapshot.receipt?.blockNumber;
}

function toExecutionInput(
  result: Awaited<ReturnType<ChainAnalysisDataPlane['execution']['loadExecutionData']>> | undefined,
) {
  if (result === undefined || (result.trace === undefined && result.poolMetadata.length === 0)) {
    return undefined;
  }
  return {
    poolMetadata: result.poolMetadata,
    ...(result.trace === undefined ? {} : { trace: result.trace }),
  };
}

function derivePoolCandidates(
  snapshot: EvmTransactionSnapshot,
): Array<{ poolAddress: string; protocol: 'uniswap_v2' | 'uniswap_v3' }> {
  const candidates = new Map<string, 'ambiguous' | 'uniswap_v2' | 'uniswap_v3'>();
  for (const log of snapshot.receipt?.logs ?? []) {
    const topic = log.topics[0];
    const protocol =
      topic === UNISWAP_V2_SWAP_TOPIC
        ? 'uniswap_v2'
        : topic === UNISWAP_V3_SWAP_TOPIC
          ? 'uniswap_v3'
          : undefined;
    if (protocol === undefined) {
      continue;
    }
    const existing = candidates.get(log.address);
    candidates.set(
      log.address,
      existing === undefined || existing === protocol ? protocol : 'ambiguous',
    );
  }
  return Array.from(candidates, ([poolAddress, protocol]) => ({ poolAddress, protocol }))
    .filter(
      (
        candidate,
      ): candidate is {
        poolAddress: string;
        protocol: 'uniswap_v2' | 'uniswap_v3';
      } => candidate.protocol !== 'ambiguous',
    )
    .sort((left, right) => left.poolAddress.localeCompare(right.poolAddress));
}

function projectInspectionOutput(
  pipeline: EvmChainAnalysisPipelineResult,
): InspectTransactionOutput {
  const capability = pipeline.capabilities.find(
    (item) => item.capability === 'chain.inspect_transaction',
  );
  if (capability?.capability !== 'chain.inspect_transaction') {
    throw new ChainAnalysisMcpToolError('tool_failure');
  }
  return inspectTransactionOutputSchema.parse({
    capability,
    coverage: pipeline.coverage,
    diagnostics: pipeline.diagnostics,
    evidence: pipeline.evidence,
    ...(pipeline.execution === undefined ? {} : { execution: pipeline.execution }),
    findings: pipeline.findings,
    inputFingerprint: pipeline.inputFingerprint,
    replayFingerprint: pipeline.replayFingerprint,
    skill: pipeline.skill,
    stages: pipeline.stages,
    status: pipeline.status,
    summary: pipeline.summary,
    transaction: pipeline.transaction,
    version: pipeline.version,
    warnings: pipeline.warnings,
  });
}

function projectSandwichOutput(pipeline: EvmChainAnalysisPipelineResult): DetectSandwichOutput {
  const capability = pipeline.capabilities.find(
    (item) => item.capability === 'chain.detect_sandwich',
  );
  if (capability?.capability !== 'chain.detect_sandwich') {
    throw new ChainAnalysisMcpToolError('tool_failure');
  }
  return detectSandwichOutputSchema.parse({
    capability,
    coverage: pipeline.coverage,
    diagnostics: pipeline.diagnostics,
    evidence: pipeline.evidence,
    ...(pipeline.execution === undefined ? {} : { execution: pipeline.execution }),
    findings: pipeline.findings,
    inputFingerprint: pipeline.inputFingerprint,
    ...(pipeline.mev === undefined ? {} : { mev: pipeline.mev }),
    replayFingerprint: pipeline.replayFingerprint,
    skill: pipeline.skill,
    stages: pipeline.stages,
    status: pipeline.status,
    summary: pipeline.summary,
    transaction: pipeline.transaction,
    version: pipeline.version,
    warnings: pipeline.warnings,
  });
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
