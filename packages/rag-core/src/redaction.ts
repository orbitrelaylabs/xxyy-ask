export function redactSensitiveSupportText(text: string): string {
  return text
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, '[transaction_hash]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/gu, '[evm_address]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[sensitive_credential]')
    .replace(
      /((?:私钥|助记词|恢复词|密钥)\s*(?:是|为|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\s*(?:is|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(/(\b(?:my\s+)?password\s*(?:is|:|=)\s*)[^\s,，。；;]+/giu, '$1[sensitive_credential]');
}

export function redactSensitiveConversationHistoryText(text: string): string {
  const publicTransactionIds: string[] = [];
  const protectTransactionId = (_match: string, prefix: string, transactionId: string) => {
    const placeholder = `[public_transaction_${publicTransactionIds.length}]`;
    publicTransactionIds.push(transactionId);
    return `${prefix}${placeholder}`;
  };
  const protectedText = text
    .replace(
      /(https:\/\/[^\s<>"']{0,240}?\/(?:tx|transaction)\/)(0x[a-fA-F0-9]{64})\b/giu,
      protectTransactionId,
    )
    .replace(
      /((?:交易哈希|交易(?!私钥|密钥)|transaction(?:\s+hash)?|tx(?:\s+hash)?)[^\n\r]{0,24}?)(0x[a-fA-F0-9]{64})\b/giu,
      protectTransactionId,
    );
  const redacted = redactSensitiveSupportText(protectedText);
  return publicTransactionIds.reduce(
    (result, transactionId, index) =>
      result.replace(`[public_transaction_${index}]`, transactionId),
    redacted,
  );
}
