import type { ChatResponse, ChatStreamEvent, Classification } from '@xxyy/shared';

import type { RetrievedChunk } from './retrieve.js';
import type { ProductSubquestion } from './product-question.js';

export interface AnswerProviderInput {
  question: string;
  classification: Classification;
  retrievedChunks: RetrievedChunk[];
  evidenceCoverage?: Array<{
    covered: boolean;
    evidenceIds: string[];
    facet: string;
  }>;
  standaloneQuestion?: string;
  subquestions?: ProductSubquestion[];
}

export interface AnswerProvider {
  answer(input: AnswerProviderInput): Promise<ChatResponse>;
  stream?(input: AnswerProviderInput): AsyncIterable<ChatStreamEvent>;
}
