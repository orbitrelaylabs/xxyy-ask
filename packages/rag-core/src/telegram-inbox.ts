import type { TelegramGroupMessageRecord } from './telegram-group-messages.js';

interface MergedTelegramInboxMessage {
  authorUserId: string;
  id: string;
  replyToMessageId?: string;
  sentAt: string;
  sourceMessageIds: string[];
  text: string;
}

export function createTelegramInboxKnowledgeExport(input: {
  chatId: string;
  messages: readonly TelegramGroupMessageRecord[];
}): {
  messageIds: string[];
  rawExport: { id: string; messages: Array<Record<string, unknown>> };
} {
  const eligible = input.messages
    .filter(
      (message) =>
        !message.authorIsBot &&
        message.senderChatId === undefined &&
        message.authorUserId !== undefined &&
        message.text.trim().length > 0,
    )
    .sort(compareMessages);
  const merged: MergedTelegramInboxMessage[] = [];
  const sourceToMerged = new Map<string, string>();

  for (const message of eligible) {
    const authorUserId = message.authorUserId;
    if (authorUserId === undefined) continue;
    const previous = merged.at(-1);
    const canMerge =
      previous !== undefined &&
      previous.authorUserId === authorUserId &&
      (message.replyToMessageId === undefined ||
        message.replyToMessageId === previous.replyToMessageId);
    if (canMerge && previous !== undefined) {
      previous.text = `${previous.text}\n${message.text.trim()}`;
      previous.sourceMessageIds.push(message.messageId);
      sourceToMerged.set(message.messageId, previous.id);
      continue;
    }
    const next: MergedTelegramInboxMessage = {
      authorUserId,
      id: message.messageId,
      sentAt: message.sentAt,
      sourceMessageIds: [message.messageId],
      text: message.text.trim(),
      ...(message.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: message.replyToMessageId }),
    };
    merged.push(next);
    sourceToMerged.set(message.messageId, next.id);
  }

  return {
    messageIds: input.messages.map((message) => message.messageId),
    rawExport: {
      id: input.chatId,
      messages: merged.map((message) => ({
        date: message.sentAt,
        from_id: `user${message.authorUserId}`,
        id: message.id,
        ...(message.replyToMessageId === undefined
          ? {}
          : {
              reply_to_message_id:
                sourceToMerged.get(message.replyToMessageId) ?? message.replyToMessageId,
            }),
        text: message.text,
        type: 'message',
      })),
    },
  };
}

function compareMessages(
  left: TelegramGroupMessageRecord,
  right: TelegramGroupMessageRecord,
): number {
  const timeDifference = Date.parse(left.sentAt) - Date.parse(right.sentAt);
  return timeDifference === 0
    ? left.messageId.localeCompare(right.messageId, 'en', { numeric: true })
    : timeDifference;
}
