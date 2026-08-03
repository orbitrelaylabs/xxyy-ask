export interface Citation {
  excerpt: string;
  file: string;
  sourceType?: 'admin_verified' | 'official_docs' | 'x_updates';
  sourceUrl?: string;
  title: string;
}

export interface Attachment {
  delivery?: 'on_request' | 'required';
  kind: 'image' | 'video';
  mediaType?: string;
  posterUrl?: string;
  title: string;
  url: string;
}

export interface ChatMetadata {
  attachments?: Attachment[];
  citations?: Citation[];
  confidence: number;
  intent: string;
}

export interface ChatMessage {
  attachments: Attachment[];
  citations: Citation[];
  id: string;
  confidence?: number;
  feedbackStatus?: 'error' | 'negative' | 'positive' | 'submitting';
  intent?: string;
  meta?: string;
  rawAnswer: string;
  role: 'assistant' | 'user';
  question?: string;
  status?: 'error' | 'streaming' | undefined;
  statusMessage?: string;
  text: string;
}

export type ChatStreamEvent =
  | { event: 'answer_delta'; payload: { delta?: string } }
  | { event: 'status'; payload: { message?: string; phase?: string } }
  | { event: 'metadata'; payload: ChatMetadata }
  | { event: 'error'; payload: { message?: string } }
  | { event: 'unknown'; eventName: string; payload: unknown };
