import { AsyncLocalStorage } from 'node:async_hooks';

import { redactSensitiveSupportText } from './redaction.js';
import type { RetrievedChunk } from './retrieve.js';

type QualityRunType = 'chain' | 'embedding' | 'llm' | 'retriever' | 'tool';
type QualityTraceStatus = 'cancelled' | 'error' | 'running' | 'success';

export interface QualitySpanInput<T = unknown> {
  inputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  name: string;
  output?: (value: T) => Record<string, unknown>;
  runType: QualityRunType;
}

export interface QualityStreamSpanInput<T> extends Omit<QualitySpanInput<never>, 'output'> {
  event?: (value: T) => Record<string, unknown> | undefined;
  output?: (events: readonly Record<string, unknown>[]) => Record<string, unknown>;
}

export interface QualityTracer {
  run<T>(span: QualitySpanInput<T>, task: () => Promise<T>): Promise<T>;
  stream<T>(span: QualityStreamSpanInput<T>, task: () => AsyncIterable<T>): AsyncIterable<T>;
}

export interface QualityTraceRecord {
  durationMs: number;
  endedAt?: number;
  errorName?: string;
  id: string;
  inputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  name: string;
  outputs?: Record<string, unknown>;
  parentId?: string;
  runType: QualityRunType;
  startedAt: number;
  status: QualityTraceStatus;
}

let nextTraceId = 0;

export const noopQualityTracer: QualityTracer = {
  run: (_span, task) => task(),
  stream: (_span, task) => task(),
};

export function createInMemoryQualityTracer(options: { now?: () => number } = {}): {
  records: QualityTraceRecord[];
  tracer: QualityTracer;
} {
  const now = options.now ?? Date.now;
  const records: QualityTraceRecord[] = [];
  const traceContext = new AsyncLocalStorage<string>();

  const tracer: QualityTracer = {
    async run<T>(span: QualitySpanInput<T>, task: () => Promise<T>): Promise<T> {
      const record = startRecord(span, now, traceContext.getStore());
      records.push(record);
      return traceContext.run(record.id, async () => {
        try {
          const value = await task();
          if (span.output !== undefined) {
            const outputs = summarize(() => span.output?.(value));
            if (outputs !== undefined) {
              record.outputs = outputs;
            }
          }
          record.status = 'success';
          return value;
        } catch (error) {
          record.errorName = error instanceof Error ? error.name : 'UnknownError';
          record.status = 'error';
          throw error;
        } finally {
          finishRecord(record, now);
        }
      });
    },

    stream<T>(span: QualityStreamSpanInput<T>, task: () => AsyncIterable<T>): AsyncIterable<T> {
      return streamWithRecord(span, task, records, now, traceContext);
    },
  };

  return { records, tracer };
}

async function* streamWithRecord<T>(
  span: QualityStreamSpanInput<T>,
  task: () => AsyncIterable<T>,
  records: QualityTraceRecord[],
  now: () => number,
  traceContext: AsyncLocalStorage<string>,
): AsyncIterable<T> {
  const record = startRecord(span, now, traceContext.getStore());
  records.push(record);
  const summaries: Record<string, unknown>[] = [];
  let completed = false;
  let iterator: AsyncIterator<T> | undefined;

  try {
    const iterable = traceContext.run(record.id, task);
    iterator = iterable[Symbol.asyncIterator]();
    while (true) {
      const next = await traceContext.run(record.id, () => iterator?.next());
      if (next === undefined || next.done === true) {
        completed = true;
        record.status = 'success';
        break;
      }
      if (span.event !== undefined) {
        const summary = summarize(() => span.event?.(next.value));
        if (summary !== undefined) {
          summaries.push(summary);
        }
      }
      yield next.value;
    }
  } catch (error) {
    record.errorName = error instanceof Error ? error.name : 'UnknownError';
    record.status = 'error';
    throw error;
  } finally {
    if (!completed && record.status !== 'error') {
      record.status = 'cancelled';
      await traceContext.run(record.id, async () => iterator?.return?.());
    }
    if (span.output !== undefined) {
      const outputs = summarize(() => span.output?.(summaries));
      if (outputs !== undefined) {
        record.outputs = outputs;
      }
    }
    finishRecord(record, now);
  }
}

function startRecord(
  span: Pick<QualitySpanInput<unknown>, 'inputs' | 'metadata' | 'name' | 'runType'>,
  now: () => number,
  parentId: string | undefined,
): QualityTraceRecord {
  const startedAt = now();
  return {
    durationMs: 0,
    id: `quality_${++nextTraceId}`,
    ...(span.inputs === undefined ? {} : { inputs: sanitizeQualityRecord(span.inputs) }),
    ...(span.metadata === undefined ? {} : { metadata: sanitizeQualityRecord(span.metadata) }),
    name: span.name,
    ...(parentId === undefined ? {} : { parentId }),
    runType: span.runType,
    startedAt,
    status: 'running',
  };
}

function finishRecord(record: QualityTraceRecord, now: () => number): void {
  const endedAt = now();
  record.endedAt = endedAt;
  record.durationMs = Math.max(0, endedAt - record.startedAt);
}

function summarize(
  createSummary: () => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  try {
    const summary = createSummary();
    return summary === undefined ? undefined : sanitizeQualityRecord(summary);
  } catch (error) {
    return { summaryError: error instanceof Error ? error.name : 'UnknownError' };
  }
}

export function sanitizeQualityRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(value, 0) as Record<string, unknown>;
}

export function summarizeRetrievedChunks(
  chunks: readonly RetrievedChunk[],
): Array<Record<string, unknown>> {
  return chunks.slice(0, 20).map((chunk) => ({
    id: chunk.id,
    lexicalScore: chunk.lexicalScore,
    rank: chunk.rank,
    score: chunk.score,
    sourceType: chunk.metadata.sourceType,
    status: chunk.metadata.status ?? 'current',
    vectorScore: chunk.vectorScore,
  }));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= 6) {
    return '[max_depth]';
  }
  if (typeof value === 'string') {
    return redactSensitiveSupportText(value).slice(0, 1_000);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      result[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return `[${typeof value}]`;
}

function isSensitiveKey(key: string): boolean {
  return /^(?:apiKey|authorization|password|privateKey|rawAnswer|rawPrompt|secret|sessionId|userId)$/iu.test(
    key,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
